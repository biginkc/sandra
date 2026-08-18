"use server";

import { after } from "next/server";
import { start } from "workflow/api";

import { bulkSmsWorkflow } from "@/workflows/bulk-sms";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  completeLaunchingCampaign,
  normalizeAdHocCampaignName,
  resolveAdHocBulkSmsCampaign,
  settleAdHocCampaignAfterQueueFailure,
} from "@/lib/campaigns/ad-hoc-bulk-sms";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import {
  assessAudienceLineTypes,
  type AudienceLineTypeAssessment,
} from "@/lib/messaging/audience-assessment";
import {
  loadCampaignDeliverySettings,
  normalizeSenderNumber,
} from "@/lib/messaging/delivery";
import {
  CONTACTED_MESSAGE_STATUSES,
  freshScheduleState,
  queueSmsBatch,
  type BulkSmsQueueBaseOpts,
  type BulkSmsQueueOpts,
  type ResolvedBulkSmsQueueOpts,
} from "@/lib/messaging/bulk-queue";
import {
  type SmsPacingProfile,
  validateSmsPaceSeconds,
} from "@/lib/messaging/pacing";
import {
  buildSnapshotsForProperty,
  type DialerBatchItemSnapshot,
} from "@/lib/dialer/snapshot-identity";
import {
  previewBatchEligibility as classifyForPreview,
  type BatchEligibilityCounts,
  type ClassifyInput,
} from "@/lib/dialer/eligibility";

import {
  applyFilters,
  filterSelectFragment,
} from "@/lib/prospects/filter-to-supabase";
import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { resolveProspectEligibility } from "@/lib/prospects/eligibility";
import { getDayBoundsInZone } from "@/lib/time/zoned";

export async function listSmsTemplateCategories(): Promise<
  Result<{ category: string; count: number }[]>
> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("sms_templates")
      .select("category")
      .is("deleted_at", null);
    if (error) {
      return {
        ok: false,
        error: { code: "LIST_CATEGORIES_FAILED", message: error.message },
      };
    }
    const counts = new Map<string, number>();
    for (const row of data ?? []) {
      counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
    }
    return ok(
      Array.from(counts.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, count]) => ({ category, count })),
    );
  } catch (e) {
    reportError(e, { tags: { surface: "list_sms_template_categories" } });
    return errFromUnknown(e, "LIST_CATEGORIES_FAILED");
  }
}

/**
 * Pre-send line-type assessment for the bulk SMS modal — "X mobile /
 * Y landline / Z unknown" so the operator sees exactly who gets texted
 * (and who's excluded) before confirming. Landlines never queue;
 * unknowns queue only with the modal's opt-in toggle.
 */
export async function assessBulkSmsAudience(
  propertyIds: string[],
): Promise<Result<AudienceLineTypeAssessment>> {
  try {
    const supabase = await createClient();
    return ok(await assessAudienceLineTypes(supabase, propertyIds));
  } catch (e) {
    reportError(e, { tags: { surface: "assess_bulk_sms_audience" } });
    return errFromUnknown(e, "AUDIENCE_ASSESSMENT_FAILED");
  }
}

export type BulkSmsOutcome = {
  succeeded: number;
  skipped: number;
  failed: { propertyId: string; message: string }[];
  /** Set when the batch was too large for the synchronous path and was
   *  handed to the bulk-sms workflow instead. Counts above are zero;
   *  real counts land on the job row as the workflow progresses. */
  deferred?: { jobId: string; total: number };
};

/**
 * Queue a paced batch of outbound SMS messages for the given property IDs.
 *
 * Selections up to SYNC_BULK_SMS_LIMIT run inline (same behavior as
 * always — the integration suite pins the scheduling math). Larger
 * selections are handed to the bulk-sms workflow, which runs the same
 * queueSmsBatch loop in 200-row chunks across separate invocations —
 * a single invocation dies at the platform's 5-minute ceiling at
 * roughly 2.5K rows (same failure class as #240/#241).
 *
 * Pacing and ±jitterPct gap jitter are implemented in
 * @/lib/messaging/bulk-queue. There are NO client-side volume caps —
 * provider credits are the only cap (Jarrad's standing rule).
 */
const SYNC_BULK_SMS_LIMIT = 500;
const VALIDATION_CHUNK = 250;

function resolveProvidedCampaignId(opts: BulkSmsQueueOpts): string | null {
  return "campaignId" in opts &&
    typeof opts.campaignId === "string" &&
    opts.campaignId.trim().length > 0
    ? opts.campaignId.trim()
    : null;
}

function baseBulkSmsOpts(opts: BulkSmsQueueOpts): BulkSmsQueueBaseOpts {
  const pacingProfile = resolveServerOwnedPacingProfile(opts);
  return {
    body: opts.body,
    templateCategory: opts.templateCategory,
    paceSeconds: opts.paceSeconds,
    pacingProfile,
    skipIfContacted: opts.skipIfContacted,
    jitterPct: opts.jitterPct,
    includeUnknown: opts.includeUnknown,
    senderNumber: opts.senderNumber,
    providerCampaignExternalId: opts.providerCampaignExternalId,
  };
}

function validateBulkSmsQueuePace(
  opts: BulkSmsQueueOpts,
  mode: "bulk" | "saved_campaign",
): Result<number> {
  const paceValidation = validateSmsPaceSeconds(opts.paceSeconds, {
    mode,
    pacingProfile: resolveServerOwnedPacingProfile(opts),
  });
  if (!paceValidation.ok) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: paceValidation.message,
      },
    };
  }
  return ok(paceValidation.paceSeconds);
}

function resolveServerOwnedPacingProfile(
  opts: BulkSmsQueueOpts,
): SmsPacingProfile | undefined {
  return opts.pacingProfile === "canary" &&
    process.env.SANDRA_SMS_CANARY_PACING_ENABLED === "true"
    ? "canary"
    : undefined;
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

async function validateProvidedCampaignForBulkSms(
  supabase: Awaited<ReturnType<typeof createClient>>,
  campaignId: string,
  propertyIds: string[],
  requestedSenderNumber?: string,
): Promise<Result<null>> {
  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .select("org_id, status")
    .eq("id", campaignId)
    .maybeSingle();

  if (campaignError) {
    return {
      ok: false,
      error: { code: "CAMPAIGN_LOOKUP_FAILED", message: campaignError.message },
    };
  }
  if (!campaign) {
    return {
      ok: false,
      error: { code: "CAMPAIGN_NOT_FOUND", message: "Campaign not found." },
    };
  }
  if (campaign.status !== "launching") {
    return {
      ok: false,
      error: {
        code: "CAMPAIGN_STATE_CONFLICT",
        message: "Campaign must be launching before bulk SMS can queue it.",
      },
    };
  }
  const delivery = await loadCampaignDeliverySettings(supabase, campaignId);
  if (!delivery.senderNumber) {
    return {
      ok: false,
      error: {
        code: "CAMPAIGN_SENDER_REQUIRED",
        message:
          "Campaign has no sending number. Set Delivery (sending number) before queueing SMS.",
      },
    };
  }
  if (
    requestedSenderNumber &&
    normalizeSenderNumber(requestedSenderNumber) !==
      normalizeSenderNumber(delivery.senderNumber)
  ) {
    return {
      ok: false,
      error: {
        code: "SENDER_LOCKED",
        message:
          `Campaign sends from ${delivery.senderNumber} and its sender is locked. ` +
          "Create a new campaign to send from a different number.",
      },
    };
  }

  const requestedIds = uniqueIds(propertyIds);
  if (requestedIds.length === 0) return ok(null);

  const propertyOrgIds = new Set<string>();
  let readableCount = 0;
  for (let i = 0; i < requestedIds.length; i += VALIDATION_CHUNK) {
    const chunk = requestedIds.slice(i, i + VALIDATION_CHUNK);
    const { data, error } = await supabase
      .from("properties")
      .select("id, org_id")
      .in("id", chunk);
    if (error) {
      return {
        ok: false,
        error: {
          code: "CAMPAIGN_AUDIENCE_LOOKUP_FAILED",
          message: error.message,
        },
      };
    }
    readableCount += data?.length ?? 0;
    data?.forEach((row) => {
      if (row.org_id) propertyOrgIds.add(row.org_id);
    });
  }

  if (readableCount !== requestedIds.length || propertyOrgIds.size !== 1) {
    return {
      ok: false,
      error: {
        code: "CAMPAIGN_AUDIENCE_ORG_MISMATCH",
        message: "Campaign send must resolve to one readable organization.",
      },
    };
  }
  if (!propertyOrgIds.has(campaign.org_id)) {
    return {
      ok: false,
      error: {
        code: "CAMPAIGN_AUDIENCE_ORG_MISMATCH",
        message:
          "Campaign and selected prospects must belong to the same organization.",
      },
    };
  }

  return ok(null);
}

async function markDeferredBulkSmsStartFailed(args: {
  campaignId: string | null;
  count: number;
  jobId: string;
  error: unknown;
}): Promise<void> {
  const adminClient = createAdminClient();
  const message =
    args.error instanceof Error ? args.error.message : String(args.error);
  await adminClient
    .from("jobs")
    .update({
      status: "failed",
      failed_items: args.count,
      completed_at: new Date().toISOString(),
      result_summary: {
        queued: 0,
        skipped: 0,
        failed: args.count,
        workflow_start_error: message,
      },
    })
    .eq("id", args.jobId);

  if (args.campaignId) {
    await settleAdHocCampaignAfterQueueFailure(adminClient, args.campaignId);
  }
}

export async function bulkQueueSms(
  propertyIds: string[],
  opts: BulkSmsQueueOpts,
): Promise<Result<BulkSmsOutcome>> {
  try {
    const supabase = await createClient();

    // Resolve the current session user for audit/job ownership only.
    // `{{my_first_name}}` is a fixed outbound sender persona now.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const enrolledByUserId = user?.id ?? null;
    const providedCampaignId = resolveProvidedCampaignId(opts);
    if (providedCampaignId && "campaignName" in opts) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Provide a campaign ID or a campaign name, not both.",
        },
      };
    }
    const isAdHoc = !providedCampaignId;

    if (!providedCampaignId) {
      const nameResult = normalizeAdHocCampaignName(
        "campaignName" in opts ? opts.campaignName : undefined,
      );
      if (!nameResult.ok) return nameResult;
    }

    if (propertyIds.length === 0) {
      return ok({ succeeded: 0, skipped: 0, failed: [] });
    }

    let resolvedPropertyIds = Array.from(new Set(propertyIds));
    let resolvedOpts: ResolvedBulkSmsQueueOpts;

    if (providedCampaignId) {
      const paceValidation = validateBulkSmsQueuePace(opts, "saved_campaign");
      if (!paceValidation.ok) return paceValidation;
      const campaignValidation = await validateProvidedCampaignForBulkSms(
        supabase,
        providedCampaignId,
        resolvedPropertyIds,
        opts.senderNumber,
      );
      if (!campaignValidation.ok) return campaignValidation;
      resolvedOpts = {
        ...baseBulkSmsOpts(opts),
        paceSeconds: paceValidation.data,
        campaignId: providedCampaignId,
        campaignSource: "saved_campaign",
      };
    } else if (
      "campaignName" in opts &&
      typeof opts.campaignName === "string"
    ) {
      const paceValidation = validateBulkSmsQueuePace(opts, "bulk");
      if (!paceValidation.ok) return paceValidation;
      const baseOpts = {
        ...baseBulkSmsOpts(opts),
        paceSeconds: paceValidation.data,
      };
      const campaignResult = await resolveAdHocBulkSmsCampaign(supabase, {
        campaignName: opts.campaignName,
        createdByUserId: enrolledByUserId,
        opts: baseOpts,
        propertyIds,
      });
      if (!campaignResult.ok) return campaignResult;
      resolvedPropertyIds = campaignResult.data.propertyIds;
      resolvedOpts = {
        ...baseOpts,
        campaignId: campaignResult.data.campaignId,
        campaignSource: "ad_hoc_bulk_sms",
      };
    } else {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Campaign name is required.",
        },
      };
    }

    if (resolvedPropertyIds.length <= SYNC_BULK_SMS_LIMIT) {
      let state;
      try {
        state = await queueSmsBatch(supabase, {
          propertyIds: resolvedPropertyIds,
          opts: resolvedOpts,
          state: freshScheduleState(Date.now()),
        });
      } catch (e) {
        if (isAdHoc) {
          await settleAdHocCampaignAfterQueueFailure(
            supabase,
            resolvedOpts.campaignId,
          );
        }
        throw e;
      }
      if (isAdHoc) {
        const completedResult = await completeLaunchingCampaign(
          supabase,
          resolvedOpts.campaignId,
        );
        if (!completedResult.ok) return completedResult;
      }
      return ok({
        succeeded: state.succeeded,
        skipped: state.skipped,
        failed: state.failed,
      });
    }

    // Large selection: create a bulk_sms job and let the workflow chunk
    // through it. Org for the job row comes from the first property.
    const { data: probe } = await supabase
      .from("properties")
      .select("org_id")
      .eq("id", resolvedPropertyIds[0])
      .single();
    if (!probe?.org_id) {
      if (isAdHoc) {
        await settleAdHocCampaignAfterQueueFailure(
          supabase,
          resolvedOpts.campaignId,
        );
      }
      return {
        ok: false,
        error: {
          code: "BULK_SMS_JOB_CREATE_FAILED",
          message: "Could not resolve the selection's organization",
        },
      };
    }

    const { data: jobRow, error: jobError } = await supabase
      .from("jobs")
      .insert({
        type: "bulk_sms",
        status: "queued",
        org_id: probe.org_id,
        created_by: user?.id ?? null,
        total_items: resolvedPropertyIds.length,
        title: `Bulk SMS queue ${resolvedPropertyIds.length.toLocaleString()} prospects`,
        description: resolvedOpts.templateCategory
          ? `Template pool "${resolvedOpts.templateCategory}"`
          : "Custom message",
        input_params: {
          property_ids: resolvedPropertyIds,
          opts: resolvedOpts,
          anchor_ms: Date.now(),
        },
      })
      .select("id")
      .single();
    if (jobError || !jobRow) {
      if (isAdHoc) {
        await settleAdHocCampaignAfterQueueFailure(
          supabase,
          resolvedOpts.campaignId,
        );
      }
      return {
        ok: false,
        error: {
          code: "BULK_SMS_JOB_CREATE_FAILED",
          message: jobError?.message ?? "Job creation failed",
        },
      };
    }

    after(async () => {
      try {
        await start(bulkSmsWorkflow, [{ jobId: jobRow.id }]);
      } catch (e) {
        await markDeferredBulkSmsStartFailed({
          campaignId: isAdHoc ? resolvedOpts.campaignId : null,
          count: resolvedPropertyIds.length,
          jobId: jobRow.id,
          error: e,
        });
        reportError(e, {
          tags: { surface: "bulk_sms_workflow_start" },
          extra: { jobId: jobRow.id, count: resolvedPropertyIds.length },
        });
      }
    });

    return ok({
      succeeded: 0,
      skipped: 0,
      failed: [],
      deferred: { jobId: jobRow.id, total: resolvedPropertyIds.length },
    });
  } catch (e) {
    reportError(e, { tags: { surface: "bulk_queue_sms" } });
    return errFromUnknown(e, "BULK_SMS_FAILED");
  }
}

type DialerPropertyRow = {
  id: string;
  org_id: string;
  state: string;
  is_dnc_locked: boolean | null;
  outreach_dispo: string | null;
  homeowner: {
    id: string;
    phone_1: string | null;
    phone_2: string | null;
    phone_3: string | null;
    do_not_contact: boolean;
    sms_opted_out: boolean;
  } | null;
};

type RawDialerPropertyRow = Omit<DialerPropertyRow, "homeowner"> & {
  homeowner: DialerPropertyRow["homeowner"] | DialerPropertyRow["homeowner"][];
};

type CreateDialerBatchOptions = {
  title?: string;
  sourceKind?: "selected_ids" | "filters" | "list";
  sourceMeta?: Record<string, unknown>;
};

type CreateDialerBatchResult = {
  batchId: string;
  counts: BatchEligibilityCounts;
};

type DialerInsertError = { message: string } | null;
type DialerInsertClient = {
  from(table: "dialer_batches"): {
    insert(values: unknown): {
      select(columns: string): {
        single(): Promise<{
          data: { id: string } | null;
          error: DialerInsertError;
        }>;
      };
    };
  };
  from(table: "dialer_batch_items"): {
    insert(values: unknown): Promise<{ error: DialerInsertError }>;
  };
};

const DIALER_CHUNK = 250;

function toClassifyInputs(rows: DialerPropertyRow[]): ClassifyInput[] {
  return rows.map((row) => ({
    property: {
      id: row.id,
      state: row.state,
      is_dnc_locked: row.is_dnc_locked,
      outreach_dispo: row.outreach_dispo,
    },
    contact: row.homeowner,
  }));
}

async function fetchDialerPropertyRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  propertyIds: string[],
): Promise<Result<DialerPropertyRow[]>> {
  const properties: DialerPropertyRow[] = [];

  for (let i = 0; i < propertyIds.length; i += DIALER_CHUNK) {
    const chunk = propertyIds.slice(i, i + DIALER_CHUNK);
    const { data, error } = await supabase
      .from("properties")
      .select(
        `id, org_id, state, is_dnc_locked, outreach_dispo,
         homeowner:contacts!properties_homeowner_contact_id_fkey(
           id, phone_1, phone_2, phone_3, do_not_contact, sms_opted_out
         )`,
      )
      .in("id", chunk)
      .is("deleted_at", null);

    if (error) {
      return {
        ok: false,
        error: { code: "DIALER_PROPERTIES_FAILED", message: error.message },
      };
    }

    properties.push(
      ...((data ?? []) as unknown as RawDialerPropertyRow[]).map((row) => ({
        ...row,
        homeowner: Array.isArray(row.homeowner)
          ? (row.homeowner[0] ?? null)
          : row.homeowner,
      })),
    );
  }

  return ok(properties);
}

async function fetchEligibleDialerPropertyRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  propertyIds: string[],
): Promise<
  Result<{
    rows: DialerPropertyRow[];
    eligibleIds: string[];
    dncLockedCount: number;
  }>
> {
  const eligibility = await resolveProspectEligibility(
    supabase,
    propertyIds,
    "dialer",
  );
  const rowsResult = await fetchDialerPropertyRows(
    supabase,
    eligibility.eligibleIds,
  );
  if (!rowsResult.ok) return rowsResult;
  return ok({
    rows: rowsResult.data,
    eligibleIds: eligibility.eligibleIds,
    dncLockedCount: eligibility.dncLockedCount,
  });
}

export async function previewBatchEligibilityAction(
  propertyIds: string[],
): Promise<Result<BatchEligibilityCounts>> {
  if (propertyIds.length === 0) {
    return ok({ callable: 0, blocked: {}, missing: 0 });
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "UNAUTH", message: "Sign in required" },
      };
    }

    const rowsResult = await fetchEligibleDialerPropertyRows(
      supabase,
      propertyIds,
    );
    if (!rowsResult.ok) return rowsResult;

    const counts = classifyForPreview(toClassifyInputs(rowsResult.data.rows));
    if (rowsResult.data.dncLockedCount > 0) {
      counts.blocked.dnc_locked = rowsResult.data.dncLockedCount;
    }
    return ok(counts);
  } catch (e) {
    reportError(e, { tags: { surface: "preview_batch_eligibility_action" } });
    return errFromUnknown(e, "PREVIEW_FAILED");
  }
}

export async function createDialerBatchFromPropertyIds(
  propertyIds: string[],
  opts: CreateDialerBatchOptions = {},
): Promise<Result<CreateDialerBatchResult>> {
  if (propertyIds.length === 0) {
    return {
      ok: false,
      error: {
        code: "NO_PROPERTIES",
        message: "Select at least one prospect.",
      },
    };
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "UNAUTH", message: "Sign in required" },
      };
    }

    const rowsResult = await fetchEligibleDialerPropertyRows(
      supabase,
      propertyIds,
    );
    if (!rowsResult.ok) {
      return {
        ok: false,
        error: {
          code: "BATCH_CREATE_FAILED",
          message: rowsResult.error.message,
        },
      };
    }
    if (rowsResult.data.eligibleIds.length === 0) {
      return {
        ok: false,
        error: {
          code: "NO_ELIGIBLE_PROPERTIES",
          message:
            "The selected prospects are Do Not Contact or no longer available.",
        },
      };
    }

    const rows = rowsResult.data.rows;
    const orgIds = new Set(rows.map((row) => row.org_id));
    if (orgIds.size !== 1) {
      return {
        ok: false,
        error: {
          code: "CROSS_ORG",
          message: "Selected prospects must belong to one organization.",
        },
      };
    }

    const orgId = rows[0]?.org_id;
    if (!orgId) {
      return {
        ok: false,
        error: {
          code: "BATCH_CREATE_FAILED",
          message: "No readable prospects.",
        },
      };
    }

    const counts = classifyForPreview(toClassifyInputs(rows));
    if (rowsResult.data.dncLockedCount > 0) {
      counts.blocked.dnc_locked = rowsResult.data.dncLockedCount;
    }
    const snapshots = rows.flatMap((row) =>
      row.homeowner
        ? buildSnapshotsForProperty(
            { id: row.id, state: row.state },
            row.homeowner,
          )
        : [],
    );
    const dialerInsertClient = supabase as unknown as DialerInsertClient;

    const { data: batch, error: batchError } = await dialerInsertClient
      .from("dialer_batches")
      .insert({
        org_id: orgId,
        title: opts.title ?? null,
        source_kind: opts.sourceKind ?? "selected_ids",
        source_meta: opts.sourceMeta ?? {
          property_ids: rowsResult.data.eligibleIds,
        },
        created_by_user_id: user.id,
      })
      .select("id")
      .single();

    if (batchError || !batch?.id) {
      return {
        ok: false,
        error: {
          code: "BATCH_CREATE_FAILED",
          message: batchError?.message ?? "Failed to create dialer batch.",
        },
      };
    }

    const itemRows = snapshots.map(
      (snapshot: DialerBatchItemSnapshot, sort_order: number) => ({
        batch_id: batch.id,
        property_id: snapshot.property_id,
        contact_id: snapshot.contact_id,
        phone_e164: snapshot.phone_e164,
        phone_label: snapshot.phone_label,
        state: snapshot.state,
        timezone: snapshot.timezone,
        calling_window_start_hour: snapshot.calling_window_start_hour,
        calling_window_end_hour: snapshot.calling_window_end_hour,
        sort_order,
      }),
    );

    for (let i = 0; i < itemRows.length; i += 500) {
      const { error: itemsError } = await dialerInsertClient
        .from("dialer_batch_items")
        .insert(itemRows.slice(i, i + 500));
      if (itemsError) {
        return {
          ok: false,
          error: { code: "BATCH_CREATE_FAILED", message: itemsError.message },
        };
      }
    }

    return ok({ batchId: batch.id as string, counts });
  } catch (e) {
    reportError(e, {
      tags: { surface: "create_dialer_batch_from_property_ids" },
    });
    return errFromUnknown(e, "BATCH_CREATE_FAILED");
  }
}

export async function createDialerBatchFromFilters(args: {
  search?: string | null;
  blockStack: FilterBlock[];
  imported?: "today" | null;
  title?: string;
}): Promise<Result<CreateDialerBatchResult>> {
  const selectionResult = await getAllMatchingProspectSelection({
    search: args.search ?? null,
    blockStack: args.blockStack,
    imported: args.imported ?? null,
  });
  if (!selectionResult.ok) return selectionResult;

  const result = await createDialerBatchFromPropertyIds(
    selectionResult.data.eligibleIds,
    {
      title: args.title,
      sourceKind: "filters",
      sourceMeta: {
        search: args.search ?? null,
        blockStack: args.blockStack,
        imported: args.imported ?? null,
      },
    },
  );
  if (!result.ok || selectionResult.data.dncLockedCount === 0) return result;

  return ok({
    ...result.data,
    counts: {
      ...result.data.counts,
      blocked: {
        ...result.data.counts.blocked,
        dnc_locked:
          (result.data.counts.blocked.dnc_locked ?? 0) +
          selectionResult.data.dncLockedCount,
      },
    },
  });
}

/**
 * Return every property_id matching the current filter set on the
 * prospects page. Used by the "Select all N prospects across all pages"
 * affordance (R9) — the table fetches the full ID set once, expands its
 * client-side selection Set, and existing bulk actions (which already
 * accept arrays of IDs) work unchanged.
 *
 * Plan 09: signature migrated to accept the v1 block stack instead of the
 * legacy 5-chip ParsedProspectsFilters. Filter chain mirrors page.tsx:
 *   - .is("deleted_at", null)                            (always)
 *   - .or("status.eq.prospect,is_dnc_locked.eq.true") UNLESS the stack contains a
 *     pipeline_status block (in which case that block's values fully
 *     define the active status set — same rule as page.tsx)
 *   - search → ILIKE on address
 *   - applyFilters(query, blockStack, supabase)          (Plan 04 translator)
 *
 * Returns every matching row. Credit-spending bulk actions carry their own
 * guards (skip-trace: MAX_PROPERTIES_PER_JOB server-side + CASS-unverified
 * filtering), so select-all itself is unbounded.
 */
export async function getAllMatchingProspectSelection(args: {
  search: string | null;
  blockStack: FilterBlock[];
  imported?: "today" | null;
}): Promise<
  Result<{
    eligibleIds: string[];
    eligibleCount: number;
    dncLockedCount: number;
    matchedCount: number;
  }>
> {
  try {
    const supabase = await createClient();

    const hasPipelineStatusBlock = args.blockStack.some(
      (b) => b.kind === "pipeline_status",
    );

    const filterSelect = filterSelectFragment(args.blockStack);
    const propertiesSelect = [
      "id, source_import_id, source_imported_at",
      filterSelect,
    ]
      .filter(Boolean)
      .join(", ");

    // PostgREST silently caps results at 1 000 rows (db-max-rows default).
    // Use a deterministic ID keyset. Offset pagination can skip or duplicate
    // rows when a prospect changes state while a >1K selection is loading.
    const PAGE = 1000;
    const allIds: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      let query = supabase
        .from("properties")
        .select(propertiesSelect)
        .is("deleted_at", null);
      if (!hasPipelineStatusBlock) {
        query = query.or("status.eq.prospect,is_dnc_locked.eq.true");
      }
      if (args.search) query = query.ilike("address", `%${args.search}%`);
      if (args.imported === "today") {
        const { dayStart, dayEnd } = getDayBoundsInZone(
          new Date(),
          "America/Chicago",
        );
        query = query
          .not("source_import_id", "is", null)
          .gte("source_imported_at", dayStart.toISOString())
          .lt("source_imported_at", dayEnd.toISOString());
      }
      query = (await applyFilters(query, args.blockStack, supabase)).builder;
      if (cursor) query = query.gt("id", cursor);
      const { data, error } = await query
        .order("id", { ascending: true })
        .limit(PAGE);
      if (error) {
        return {
          ok: false,
          error: { code: "SELECT_ALL_FAILED", message: error.message },
        };
      }
      const rows = (data ?? []) as unknown as Array<{ id: string }>;
      allIds.push(...rows.map((row) => row.id));
      if (rows.length < PAGE) break;
      const nextCursor = rows.at(-1)?.id ?? null;
      if (!nextCursor || nextCursor === cursor) {
        return {
          ok: false,
          error: {
            code: "SELECT_ALL_FAILED",
            message: "Prospect selection did not advance safely.",
          },
        };
      }
      cursor = nextCursor;
    }

    const resolved = await resolveProspectEligibility(
      supabase,
      allIds,
      "selection",
    );
    return ok({
      eligibleIds: resolved.eligibleIds,
      eligibleCount: resolved.eligibleIds.length,
      dncLockedCount: resolved.dncLockedCount,
      matchedCount: allIds.length,
    });
  } catch (e) {
    reportError(e, { tags: { surface: "get_all_matching_prospect_ids" } });
    return errFromUnknown(e, "SELECT_ALL_FAILED");
  }
}

export async function getAllMatchingProspectIds(args: {
  search: string | null;
  blockStack: FilterBlock[];
  imported?: "today" | null;
}): Promise<Result<string[]>> {
  const result = await getAllMatchingProspectSelection(args);
  return result.ok ? ok(result.data.eligibleIds) : result;
}

/**
 * Count distinct properties (in `propertyIds`) that already have at least
 * one successful outbound message — fuels the Bulk SMS modal's
 * "Skip prospects already contacted (N)" checkbox label so the operator
 * sees how many leads will be excluded before they queue.
 *
 * Failed provider attempts are intentionally excluded; they are not real
 * prospect contacts.
 *
 * Empty input short-circuits to ok(0) without a DB roundtrip.
 */
export async function countAlreadyContacted(
  propertyIds: string[],
): Promise<Result<number>> {
  if (propertyIds.length === 0) return ok(0);
  try {
    const supabase = await createClient();
    const CHUNK = 250;
    const distinct = new Set<string>();
    for (let i = 0; i < propertyIds.length; i += CHUNK) {
      const chunk = propertyIds.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from("messages")
        .select("property_id")
        .in("property_id", chunk)
        .eq("direction", "outbound")
        .in("status", CONTACTED_MESSAGE_STATUSES);
      if (error) {
        return {
          ok: false,
          error: { code: "COUNT_CONTACTED_FAILED", message: error.message },
        };
      }
      (data ?? [])
        .map((r) => r.property_id)
        .filter((v): v is string => typeof v === "string")
        .forEach((v) => distinct.add(v));
    }
    return ok(distinct.size);
  } catch (e) {
    reportError(e, { tags: { surface: "count_already_contacted" } });
    return errFromUnknown(e, "COUNT_CONTACTED_FAILED");
  }
}
