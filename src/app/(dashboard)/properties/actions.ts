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

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { resolveProspectEligibility } from "@/lib/prospects/eligibility";
import {
  AD_HOC_BULK_SMS_SOURCE,
  filterToProspectIds,
} from "@/lib/messaging/prospect-only-guard";
import { parseQueryOrigin, type QueryOrigin } from "@/lib/prospects/search-scope";
import {
  selectAllMatching,
  selectionFilters,
  type PropertySelection,
  type SelectAllResult,
} from "@/lib/prospects/select-all";

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
/**
 * Resolve a selection to ids on the server. Explicit checkbox ids pass through
 * (the per-action guards re-check them); a select-all-matching selection is
 * re-resolved from its filters, so no id list round-trips through the client.
 */
async function resolveSelectionIds(
  selection: PropertySelection,
): Promise<Result<{ ids: string[]; skippedLeads: number }>> {
  const filters = selectionFilters(selection);
  if (!filters) return ok({ ids: selection as string[], skippedLeads: 0 });
  const resolved = await selectAllMatching(filters);
  if (!resolved.ok) return resolved;
  return ok({
    ids: resolved.data.eligibleIds,
    skippedLeads: resolved.data.skippedLeads,
  });
}

export async function assessBulkSmsAudience(
  selection: PropertySelection,
): Promise<Result<AudienceLineTypeAssessment & { skippedLeads: number }>> {
  try {
    const supabase = await createClient();
    const resolved = await resolveSelectionIds(selection);
    if (!resolved.ok) return resolved;
    // Same prospect-only guard as bulkQueueSms so the modal counts match what
    // will actually queue; leads in the selection are reported, not assessed.
    const guard = await filterToProspectIds(supabase, resolved.data.ids);
    return ok({
      ...(await assessAudienceLineTypes(supabase, guard.prospectIds)),
      skippedLeads: guard.skippedLeads + resolved.data.skippedLeads,
    });
  } catch (e) {
    reportError(e, { tags: { surface: "assess_bulk_sms_audience" } });
    return errFromUnknown(e, "AUDIENCE_ASSESSMENT_FAILED");
  }
}

export type BulkSmsOutcome = {
  succeeded: number;
  skipped: number;
  failed: { propertyId: string; message: string }[];
  /** Ad-hoc sends only: selected rows that are not prospects (leads etc.)
   *  and were skipped before queueing. Absent for saved-campaign sends. */
  skippedLeads?: number;
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
    .select("org_id, status, audience_snapshot")
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
  // An ad-hoc bulk-SMS campaign id must not be presented as a saved campaign:
  // that would skip the ad-hoc prospect-only guard. Provenance comes from the
  // stored campaign row.
  if (
    (campaign.audience_snapshot as { source?: unknown } | null)?.source ===
    AD_HOC_BULK_SMS_SOURCE
  ) {
    return {
      ok: false,
      error: {
        code: "CAMPAIGN_SOURCE_MISMATCH",
        message: "This campaign was created by Bulk SMS and cannot be launched as a saved campaign.",
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

  // The saved-campaign exemption from the prospect-only guard is bound to the
  // campaign's FROZEN audience: any id outside campaign_recipients is rejected.
  const frozen = new Set<string>();
  for (let i = 0; i < requestedIds.length; i += VALIDATION_CHUNK) {
    const chunk = requestedIds.slice(i, i + VALIDATION_CHUNK);
    const { data, error } = await supabase
      .from("campaign_recipients")
      .select("property_id")
      .eq("campaign_id", campaignId)
      .in("property_id", chunk);
    if (error) {
      return {
        ok: false,
        error: {
          code: "CAMPAIGN_AUDIENCE_LOOKUP_FAILED",
          message: error.message,
        },
      };
    }
    for (const row of data ?? []) frozen.add(row.property_id);
  }
  if (requestedIds.some((id) => !frozen.has(id))) {
    return {
      ok: false,
      error: {
        code: "CAMPAIGN_AUDIENCE_MISMATCH",
        message:
          "Selected properties are not part of this campaign's frozen audience.",
      },
    };
  }

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
  selection: PropertySelection,
  opts: BulkSmsQueueOpts,
): Promise<Result<BulkSmsOutcome>> {
  try {
    const supabase = await createClient();
    const providedFor = resolveProvidedCampaignId(opts);
    // A select-all-matching selection is ad-hoc only: saved campaigns send
    // their frozen audience as explicit ids.
    if (providedFor && !Array.isArray(selection)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Saved campaigns send their frozen audience, not a filter selection.",
        },
      };
    }
    const resolvedSelection = await resolveSelectionIds(selection);
    if (!resolvedSelection.ok) return resolvedSelection;
    const propertyIds = resolvedSelection.data.ids;
    const filterSkippedLeads = resolvedSelection.data.skippedLeads;

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
    let adHocSkippedLeads: number | undefined;
    const leadsField = () =>
      adHocSkippedLeads === undefined ? {} : { skippedLeads: adHocSkippedLeads };

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
      // Ad-hoc sends act on prospects only; the freeze below receives the
      // FILTERED ids (not the original selection).
      const guard = await filterToProspectIds(supabase, propertyIds);
      adHocSkippedLeads = guard.skippedLeads + filterSkippedLeads;
      if (guard.prospectIds.length === 0) {
        return ok({
          succeeded: 0,
          skipped: 0,
          failed: [],
          skippedLeads: guard.skippedLeads + filterSkippedLeads,
        });
      }
      const campaignResult = await resolveAdHocBulkSmsCampaign(supabase, {
        campaignName: opts.campaignName,
        createdByUserId: enrolledByUserId,
        opts: baseOpts,
        propertyIds: guard.prospectIds,
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
        ...leadsField(),
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
      ...leadsField(),
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
    property: { id: row.id, state: row.state },
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
        `id, org_id, state,
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
  origin?: QueryOrigin;
}): Promise<Result<CreateDialerBatchResult & { skippedLeads: number }>> {
  const origin = parseQueryOrigin(args.origin);
  const selectionResult = await getAllMatchingProspectSelection({
    search: args.search ?? null,
    blockStack: args.blockStack,
    imported: args.imported ?? null,
    origin,
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
        // Legacy batches keep their exact historical source_meta shape.
        ...(origin === "search_page" ? { origin } : {}),
      },
    },
  );
  const skippedLeads = selectionResult.data.skippedLeads;
  if (!result.ok) return result;
  if (selectionResult.data.dncLockedCount === 0) {
    return ok({ ...result.data, skippedLeads });
  }

  return ok({
    ...result.data,
    skippedLeads,
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
 * prospects/search page. Used by the "Select all N across all pages"
 * affordance (R9) — the table fetches the full ID set once, expands its
 * client-side selection Set, and existing bulk actions (which already
 * accept arrays of IDs) work unchanged.
 *
 * The predicate chain comes from `buildScopedQuery` (src/lib/prospects/
 * search-scope.ts). Origin 'legacy' (the default; campaigns and DNC-safe
 * callers) is byte-for-byte the old chain: prospect-or-DNC status unless a
 * pipeline_status block, unescaped address ilike, uncapped. Origin
 * 'search_page' shows every status, hides training rows, searches via
 * `search_properties`, and is CAPPED (SEARCH_SELECT_ALL_CAP): over the cap is
 * an error and NO partial selection is returned.
 *
 * Two distinct sets come back: MATCHED (what the page lists; `matchedCount`)
 * and ELIGIBLE (matched ∩ prospect ∩ not DNC; `eligibleIds`), with the
 * exclusions broken out (`dncLockedCount`, `skippedLeads`).
 *
 * Credit-spending bulk actions carry their own guards (skip-trace:
 * MAX_PROPERTIES_PER_JOB server-side + CASS-unverified filtering).
 */
export async function getAllMatchingProspectSelection(args: {
  search: string | null;
  blockStack: FilterBlock[];
  imported?: "today" | null;
  /** Defaults to 'legacy'. Anything but the literal 'search_page' is legacy. */
  origin?: QueryOrigin;
}): Promise<Result<SelectAllResult>> {
  return selectAllMatching(args);
}

export async function getAllMatchingProspectIds(args: {
  search: string | null;
  blockStack: FilterBlock[];
  imported?: "today" | null;
  origin?: QueryOrigin;
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
  selection: PropertySelection,
): Promise<Result<number>> {
  if (Array.isArray(selection) && selection.length === 0) return ok(0);
  try {
    const supabase = await createClient();
    const resolved = await resolveSelectionIds(selection);
    if (!resolved.ok) return resolved;
    const propertyIds = resolved.data.ids;
    // Same prospect-only guard as bulkQueueSms (counts match the real send).
    const { prospectIds } = await filterToProspectIds(supabase, propertyIds);
    const CHUNK = 250;
    const distinct = new Set<string>();
    for (let i = 0; i < prospectIds.length; i += CHUNK) {
      const chunk = prospectIds.slice(i, i + CHUNK);
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
