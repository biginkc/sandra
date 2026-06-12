"use server";

import { after } from "next/server";
import { start } from "workflow/api";

import { bulkSmsWorkflow } from "@/workflows/bulk-sms";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { sendSmsToContact } from "@/lib/messaging/send";
import {
  assessAudienceLineTypes,
  type AudienceLineTypeAssessment,
} from "@/lib/messaging/audience-assessment";
import {
  freshScheduleState,
  queueSmsBatch,
  type BulkSmsQueueOpts,
} from "@/lib/messaging/bulk-queue";
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
      return { ok: false, error: { code: "LIST_CATEGORIES_FAILED", message: error.message } };
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

export async function bulkQueueSms(
  propertyIds: string[],
  opts: BulkSmsQueueOpts,
): Promise<Result<BulkSmsOutcome>> {
  if (propertyIds.length === 0) {
    return ok({ succeeded: 0, skipped: 0, failed: [] });
  }

  try {
    const supabase = await createClient();

    // Resolve the current session user once so {{my_first_name}} renders
    // for every property in the batch. Without this, templates referencing
    // the sender token produced bodies like "Andrew,  here." (canceled in
    // prod 2026-05-05). Admin client is needed by the resolver to call
    // auth.admin.getUserById on the lookup; the WR-02 split keeps the
    // RLS-scoped reads on the session client.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const enrolledByUserId = user?.id ?? null;

    if (propertyIds.length <= SYNC_BULK_SMS_LIMIT) {
      const adminClient = createAdminClient();
      const state = await queueSmsBatch(supabase, adminClient, {
        propertyIds,
        opts,
        enrolledByUserId,
        state: freshScheduleState(Date.now()),
      });
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
      .eq("id", propertyIds[0])
      .single();
    if (!probe?.org_id) {
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
        total_items: propertyIds.length,
        title: `Bulk SMS queue ${propertyIds.length.toLocaleString()} prospects`,
        description: opts.templateCategory
          ? `Template pool "${opts.templateCategory}"`
          : "Custom message",
        input_params: {
          property_ids: propertyIds,
          opts,
          enrolled_by_user_id: enrolledByUserId,
          anchor_ms: Date.now(),
        },
      })
      .select("id")
      .single();
    if (jobError || !jobRow) {
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
        reportError(e, {
          tags: { surface: "bulk_sms_workflow_start" },
          extra: { jobId: jobRow.id, count: propertyIds.length },
        });
      }
    });

    return ok({
      succeeded: 0,
      skipped: 0,
      failed: [],
      deferred: { jobId: jobRow.id, total: propertyIds.length },
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

    const rowsResult = await fetchDialerPropertyRows(supabase, propertyIds);
    if (!rowsResult.ok) return rowsResult;

    return ok(classifyForPreview(toClassifyInputs(rowsResult.data)));
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
      error: { code: "NO_PROPERTIES", message: "Select at least one prospect." },
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

    const rowsResult = await fetchDialerPropertyRows(supabase, propertyIds);
    if (!rowsResult.ok) {
      return {
        ok: false,
        error: {
          code: "BATCH_CREATE_FAILED",
          message: rowsResult.error.message,
        },
      };
    }

    const rows = rowsResult.data;
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
        error: { code: "BATCH_CREATE_FAILED", message: "No readable prospects." },
      };
    }

    const counts = classifyForPreview(toClassifyInputs(rows));
    const snapshots = rows.flatMap((row) =>
      row.homeowner
        ? buildSnapshotsForProperty(
            { id: row.id, state: row.state },
            row.homeowner,
          )
        : [],
    );

    const { data: batch, error: batchError } = await (supabase as any)
      .from("dialer_batches")
      .insert({
        org_id: orgId,
        title: opts.title ?? null,
        source_kind: opts.sourceKind ?? "selected_ids",
        source_meta: opts.sourceMeta ?? { property_ids: propertyIds },
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
      const { error: itemsError } = await (supabase as any)
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
    reportError(e, { tags: { surface: "create_dialer_batch_from_property_ids" } });
    return errFromUnknown(e, "BATCH_CREATE_FAILED");
  }
}

export async function createDialerBatchFromFilters(args: {
  search?: string | null;
  blockStack: FilterBlock[];
  title?: string;
}): Promise<Result<CreateDialerBatchResult>> {
  const idsResult = await getAllMatchingProspectIds({
    search: args.search ?? null,
    blockStack: args.blockStack,
  });
  if (!idsResult.ok) return idsResult;

  return createDialerBatchFromPropertyIds(idsResult.data, {
    title: args.title,
    sourceKind: "filters",
    sourceMeta: { search: args.search ?? null, blockStack: args.blockStack },
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
 *   - .eq("status", "prospect") UNLESS the stack contains a
 *     pipeline_status block (in which case that block's values fully
 *     define the active status set — same rule as page.tsx)
 *   - search → ILIKE on address
 *   - applyFilters(query, blockStack, supabase)          (Plan 04 translator)
 *
 * Returns every matching row. Credit-spending bulk actions carry their own
 * guards (skip-trace: MAX_PROPERTIES_PER_JOB server-side + CASS-unverified
 * filtering), so select-all itself is unbounded.
 */
export async function getAllMatchingProspectIds(args: {
  search: string | null;
  blockStack: FilterBlock[];
}): Promise<Result<string[]>> {
  try {
    const supabase = await createClient();

    const hasPipelineStatusBlock = args.blockStack.some(
      (b) => b.kind === "pipeline_status",
    );

    const filterSelect = filterSelectFragment(args.blockStack);
    const propertiesSelect = ["id", filterSelect].filter(Boolean).join(", ");

    let query = supabase
      .from("properties")
      .select(propertiesSelect)
      .is("deleted_at", null);
    if (!hasPipelineStatusBlock) {
      query = query.eq("status", "prospect");
    }

    if (args.search) {
      query = query.ilike("address", `%${args.search}%`);
    }

    // Plan 04 translator — same SQL chain the page renders against. Any
    // engagement / vacancy / cass / market / assignee / list / tag /
    // motivation_level / equity_pct / etc. is applied here, not duplicated.
    query = (await applyFilters(query, args.blockStack, supabase)).builder;

    // PostgREST silently caps results at 1 000 rows (db-max-rows default).
    // Paginate with .range() until a page comes back short to collect all IDs.
    const PAGE = 1000;
    const allIds: string[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await query.range(from, from + PAGE - 1);
      if (error) {
        return {
          ok: false,
          error: { code: "SELECT_ALL_FAILED", message: error.message },
        };
      }
      const page = ((data ?? []) as unknown as Array<{ id: string }>).map(
        (r) => r.id,
      );
      allIds.push(...page);
      if (page.length < PAGE) break;
    }

    return ok(allIds);
  } catch (e) {
    reportError(e, { tags: { surface: "get_all_matching_prospect_ids" } });
    return errFromUnknown(e, "SELECT_ALL_FAILED");
  }
}

/**
 * Count distinct properties (in `propertyIds`) that already have at least
 * one outbound message — fuels the Bulk SMS modal's
 * "Skip prospects already contacted (N)" checkbox label so the operator
 * sees how many leads will be excluded before they queue.
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
        .eq("direction", "outbound");
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
