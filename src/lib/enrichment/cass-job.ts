import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { dispatchJobCompleted } from "@/lib/notifications/dispatch";
import type { Database, Json } from "@/lib/supabase/types";
import { verifyPropertyAddress } from "./verify-property";
export { CASS_COST_PER_LOOKUP_USD } from "@/lib/provider-pricing";

export type CassJobSummary = {
  total: number;
  verified: number;
  invalid: number;
  ambiguous: number;
  cacheHits: number;
  failed: number;
  providerOff: number;
  dncSkipped?: number;
  retryableFailures?: number;
  savedResultFailures?: number;
  manualReconciliation?: number;
};

export type AuthorizedCassJob = {
  jobId: string;
  claimToken: string | null;
  created: boolean;
  status: string;
};

type CassRpcError = { message: string } | null;

type CassRpcClient = {
  rpc(
    fn: "create_authorized_cass_job",
    args: {
      p_org_id: string;
      p_property_ids: string[];
      p_purpose: "standalone" | "import" | "retry";
      p_parent_job_id: string | null;
      p_related_import_id: string | null;
      p_source_job_id: string | null;
      p_created_by: string | null;
      p_auto_start: boolean;
      p_blocked_reason: string | null;
      p_request_key: string;
    },
  ): Promise<{
    data: Array<{
      job_id: string;
      claim_token: string | null;
      created: boolean;
      job_status: string;
    }> | null;
    error: CassRpcError;
  }>;
  rpc(
    fn: "claim_authorized_cass_job_start",
    args: { p_job_id: string; p_org_id: string; p_claim_token: string | null },
  ): Promise<{ data: string | null; error: CassRpcError }>;
  rpc(
    fn: "fail_authorized_cass_job_start",
    args: {
      p_job_id: string;
      p_org_id: string;
      p_claim_token: string;
      p_message: string;
    },
  ): Promise<{ data: boolean | null; error: CassRpcError }>;
};

function cassRpcClient(supabase: SupabaseClient<Database>): CassRpcClient {
  return supabase as unknown as CassRpcClient;
}

const PROGRESS_UPDATE_INTERVAL = 10;
const DEFAULT_AUTOTRIGGER_CAP = 100;
const RECOVERY_PAGE_SIZE = 500;

function chunksOf<T>(values: T[], size = RECOVERY_PAGE_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

/**
 * Parse the autotrigger item cap from env. Controls when a CASS child job
 * runs immediately (inside the import's `after()`) vs. gets created in a
 * `queued` state for the user to start manually. The cap exists because
 * SmartyStreets charges ~$0.03/lookup and a typical DealMachine month is
 * 20K rows — blindly auto-triggering on every import would torch a free
 * tier and surprise the operator.
 */
/**
 * Per-lookup cost assumption used by the cost-confirm UI. ~$0.03/lookup is
 * SmartyStreets' US Street API rate at the time of this writing. Centralized
 * here so the UI and the plan stay in sync.
 */
/**
 * Was this CASS child job deliberately parked in `queued` by the autotrigger
 * because the import exceeded the budget cap? Used by the UI to decide
 * whether to surface a "Start CASS" button and a cost confirm. Accepts the
 * raw `jobs.result_summary` jsonb value.
 */
export function isAwaitingManualStart(resultSummary: unknown): boolean {
  if (!resultSummary || typeof resultSummary !== "object") return false;
  const val = (resultSummary as { awaiting_manual_start?: unknown })
    .awaiting_manual_start;
  return val === true;
}

export function getAutotriggerCap(): number {
  const raw = process.env.CASS_AUTOTRIGGER_MAX_ITEMS;
  if (!raw) return DEFAULT_AUTOTRIGGER_CAP;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_AUTOTRIGGER_CAP;
}

/**
 * For a parent CSV-import job, return the property_ids whose CASS status
 * would benefit from running now. Used by the import workflow's
 * auto-trigger step.
 *
 * Includes:
 *   - Newly-inserted properties (job_items.status='success')
 *   - Dedup-matched properties (job_items.status='skipped') whose
 *     cass_status is still 'unverified' — i.e. re-imports of rows whose
 *     first run pre-dated CASS or never reached the verifier.
 *
 * Excludes:
 *   - Properties already in a terminal verdict ('verified' / 'invalid' /
 *     'ambiguous'): re-running burns a SmartyStreets credit for no gain.
 *   - Properties in 'error': those have their own retry surface via
 *     retryFailedCassItems; the auto-trigger should not duplicate it.
 */
export async function selectCassEligibleProperties(
  supabase: SupabaseClient<Database>,
  parentJobId: string,
  expectedOrgId: string,
): Promise<string[]> {
  const candidateIdSet = new Set<string>();
  let lastItemId: string | null = null;
  for (;;) {
    let query = supabase
      .from("job_items")
      .select("id, property_id")
      .eq("job_id", parentJobId)
      .in("status", ["success", "skipped"])
      .not("property_id", "is", null)
      .order("id", { ascending: true })
      .limit(RECOVERY_PAGE_SIZE);
    if (lastItemId) query = query.gt("id", lastItemId);
    const { data: items, error: itemsError } = await query;
    if (itemsError) {
      throw new Error(
        `failed to read import property ledger: ${itemsError.message}`,
      );
    }
    for (const item of items ?? []) {
      if (item.property_id) candidateIdSet.add(item.property_id);
    }
    if (!items || items.length < RECOVERY_PAGE_SIZE) break;
    lastItemId = items.at(-1)?.id ?? null;
    if (!lastItemId)
      throw new Error("import property ledger page had no cursor");
  }
  const candidateIds = [...candidateIdSet];
  if (candidateIds.length === 0) return [];

  const eligibleIds: string[] = [];
  for (const candidateChunk of chunksOf(candidateIds)) {
    const { data: rows, error: propertiesError } = await supabase
      .from("properties")
      .select("id")
      .in("id", candidateChunk)
      .eq("org_id", expectedOrgId)
      .eq("cass_status", "unverified")
      .eq("is_dnc_locked", false);
    if (propertiesError) {
      throw new Error(
        `failed to read CASS candidates: ${propertiesError.message}`,
      );
    }
    eligibleIds.push(...(rows ?? []).map((row) => row.id));
  }
  if (eligibleIds.length === 0) return [];

  // A provider may have accepted a lookup even when its property write failed
  // or the response was lost. Those terminal/manual child rows must never be
  // regenerated by retrying the parent import.
  const childJobIds: string[] = [];
  let lastChildId: string | null = null;
  for (;;) {
    let query = supabase
      .from("jobs")
      .select("id")
      .eq("parent_job_id", parentJobId)
      .eq("org_id", expectedOrgId)
      .eq("type", "cass_dsf2_ncoa")
      .order("id", { ascending: true })
      .limit(RECOVERY_PAGE_SIZE);
    if (lastChildId) query = query.gt("id", lastChildId);
    const { data: childJobs, error: childJobsError } = await query;
    if (childJobsError) {
      throw new Error(
        `failed to read CASS child ledger: ${childJobsError.message}`,
      );
    }
    childJobIds.push(...(childJobs ?? []).map((row) => row.id));
    if (!childJobs || childJobs.length < RECOVERY_PAGE_SIZE) break;
    lastChildId = childJobs.at(-1)?.id ?? null;
    if (!lastChildId) throw new Error("CASS child ledger page had no cursor");
  }
  if (childJobIds.length === 0) return eligibleIds;

  const ambiguousIds = new Set<string>();
  for (const childChunk of chunksOf(childJobIds)) {
    for (const propertyChunk of chunksOf(eligibleIds)) {
      let lastAmbiguousItemId: string | null = null;
      for (;;) {
        let query = supabase
          .from("job_items")
          .select("id, property_id")
          .in("job_id", childChunk)
          .in("property_id", propertyChunk)
          .eq("status", "skipped")
          .in("error_class", ["submission_unknown"])
          .order("id", { ascending: true })
          .limit(RECOVERY_PAGE_SIZE);
        if (lastAmbiguousItemId) {
          query = query.gt("id", lastAmbiguousItemId);
        }
        const { data: ambiguousItems, error: ambiguousError } = await query;
        if (ambiguousError) {
          throw new Error(
            `failed to read ambiguous CASS ledger: ${ambiguousError.message}`,
          );
        }
        for (const item of ambiguousItems ?? []) {
          if (item.property_id) ambiguousIds.add(item.property_id);
        }
        if (!ambiguousItems || ambiguousItems.length < RECOVERY_PAGE_SIZE)
          break;
        lastAmbiguousItemId = ambiguousItems.at(-1)?.id ?? null;
        if (!lastAmbiguousItemId) {
          throw new Error("ambiguous CASS ledger page had no cursor");
        }
      }
    }
  }

  return eligibleIds.filter((id) => !ambiguousIds.has(id));
}

/**
 * Create a `cass_dsf2_ncoa` child job linked to a parent `csv_import` job.
 * Returns the new job id. Separate from `runCassEnrichment` so callers
 * can create the job in `queued` state when a budget guard blocks the
 * auto-run — the row still shows up on /jobs for the user to start.
 */
export async function createCassChildJob(
  supabase: SupabaseClient<Database>,
  params: {
    parentJobId: string;
    relatedImportId: string | null;
    createdBy: string | null;
    orgId: string;
    propertyIds: string[];
    autoStart: boolean;
    blockedReason?: string;
    sourceJobId?: string;
    requestKey: string;
  },
): Promise<AuthorizedCassJob> {
  const { data, error } = await cassRpcClient(supabase).rpc(
    "create_authorized_cass_job",
    {
      p_org_id: params.orgId,
      p_property_ids: params.propertyIds,
      p_purpose: params.sourceJobId ? "retry" : "import",
      p_parent_job_id: params.parentJobId,
      p_related_import_id: params.relatedImportId,
      p_source_job_id: params.sourceJobId ?? null,
      p_created_by: params.createdBy,
      p_auto_start: params.autoStart,
      p_blocked_reason: params.blockedReason ?? null,
      p_request_key: params.requestKey,
    },
  );

  const row = data?.[0];
  if (error || !row) {
    throw new Error(
      `failed to create cass child job: ${error?.message ?? "no job id"}`,
    );
  }
  return {
    jobId: row.job_id,
    claimToken: row.claim_token,
    created: row.created,
    status: row.job_status,
  };
}

export async function createStandaloneCassJob(
  supabase: SupabaseClient<Database>,
  params: {
    orgId: string;
    propertyIds: string[];
    createdBy: string;
    requestKey: string;
  },
): Promise<AuthorizedCassJob> {
  const { data, error } = await cassRpcClient(supabase).rpc(
    "create_authorized_cass_job",
    {
      p_org_id: params.orgId,
      p_property_ids: params.propertyIds,
      p_purpose: "standalone",
      p_parent_job_id: null,
      p_related_import_id: null,
      p_source_job_id: null,
      p_created_by: params.createdBy,
      p_auto_start: true,
      p_blocked_reason: null,
      p_request_key: params.requestKey,
    },
  );
  const row = data?.[0];
  if (error || !row) {
    throw new Error(
      `failed to create standalone CASS job: ${error?.message ?? "no job id"}`,
    );
  }
  return {
    jobId: row.job_id,
    claimToken: row.claim_token,
    created: row.created,
    status: row.job_status,
  };
}

export async function claimAuthorizedCassJobStart(
  supabase: SupabaseClient<Database>,
  params: { jobId: string; orgId: string; claimToken?: string | null },
): Promise<string> {
  const { data, error } = await cassRpcClient(supabase).rpc(
    "claim_authorized_cass_job_start",
    {
      p_job_id: params.jobId,
      p_org_id: params.orgId,
      p_claim_token: params.claimToken ?? null,
    },
  );
  if (error || !data) {
    throw new Error(
      `failed to claim CASS job start: ${error?.message ?? "no claim token"}`,
    );
  }
  return data;
}

export async function failAuthorizedCassJobStart(
  supabase: SupabaseClient<Database>,
  params: { jobId: string; orgId: string; claimToken: string; error: unknown },
): Promise<void> {
  const message =
    params.error instanceof Error ? params.error.message : String(params.error);
  const { error } = await cassRpcClient(supabase).rpc(
    "fail_authorized_cass_job_start",
    {
      p_job_id: params.jobId,
      p_org_id: params.orgId,
      p_claim_token: params.claimToken,
      p_message: message,
    },
  );
  if (error)
    throw new Error(`failed to mark CASS start failed: ${error.message}`);
}

/**
 * Verify one slice of property IDs, accumulating into (and returning) the
 * running summary. Progress writes report cumulative counts via
 * `processedBefore`, so chunked callers (cass-bulk workflow) and the
 * single-shot wrapper share identical per-row behavior.
 *
 * Never throws on per-row outcomes — provider/database row failures are
 * absorbed into job_items + summary, matching the legacy loop.
 */
export async function runCassChunk(
  supabase: SupabaseClient<Database>,
  params: {
    jobId: string;
    propertyIds: string[];
    /** Rows already processed by prior chunks (0 for the first chunk). */
    processedBefore: number;
    /** Running totals from prior chunks; mutated and returned. */
    summary: CassJobSummary;
    expectedOrgId: string;
  },
): Promise<CassJobSummary> {
  const { summary } = params;

  for (let i = 0; i < params.propertyIds.length; i++) {
    const propertyId = params.propertyIds[i];
    const outcome = await verifyPropertyAddress(
      supabase,
      propertyId,
      params.expectedOrgId,
      { jobId: params.jobId },
    );

    const persistItem = async (row: {
      status: "success" | "error" | "skipped";
      error_class?: string | null;
      error_message?: string | null;
      output_payload?: Json | null;
    }): Promise<string> => {
      const { data, error } = await supabase
        .from("job_items")
        .upsert(
          {
            job_id: params.jobId,
            property_id: propertyId,
            item_key: propertyId,
            ...row,
            processed_at: new Date().toISOString(),
          },
          { onConflict: "job_id,item_key" },
        )
        .select("id")
        .single();
      if (error)
        throw new Error(`failed to persist CASS job item: ${error.message}`);
      return data.id;
    };

    switch (outcome.status) {
      case "verified":
      case "stored_with_status":
        if (outcome.verified.cassStatus === "verified") summary.verified++;
        else if (outcome.verified.cassStatus === "invalid") summary.invalid++;
        else if (outcome.verified.cassStatus === "ambiguous")
          summary.ambiguous++;
        if (outcome.cacheHit) summary.cacheHits++;
        const jobItemId = await persistItem({
          status: "success",
        });
        await recordLeadEvent({
          propertyId,
          actorType: "system",
          eventType: LEAD_EVENT_TYPES.ADDRESS_VERIFIED,
          payload: {
            job_id: params.jobId,
            cass_status: outcome.verified.cassStatus,
            cache_hit: outcome.cacheHit,
          },
          sourceType: "job_items.cass",
          sourceId: jobItemId,
        });
        break;
      case "failed":
      case "provider_rejected":
        summary.failed++;
        summary.retryableFailures = (summary.retryableFailures ?? 0) + 1;
        await persistItem({
          status: "error",
          error_class:
            outcome.status === "provider_rejected"
              ? "provider_rejected"
              : "database",
          error_message: outcome.error,
        });
        break;
      case "no_result":
        summary.failed++;
        await persistItem({
          status: "skipped",
          error_class: "provider_no_result",
          error_message: "Provider returned no result",
        });
        break;
      case "submission_unknown":
        summary.failed++;
        summary.manualReconciliation = (summary.manualReconciliation ?? 0) + 1;
        await persistItem({
          status: "skipped",
          error_class: "submission_unknown",
          error_message: outcome.error,
        });
        break;
      case "provider_persist_failed":
        summary.failed++;
        summary.retryableFailures = (summary.retryableFailures ?? 0) + 1;
        summary.savedResultFailures = (summary.savedResultFailures ?? 0) + 1;
        await persistItem({
          status: "error",
          error_class: "provider_persist_failed",
          error_message: outcome.error,
          output_payload: {
            cass_status: outcome.verified.cassStatus,
            standardized: outcome.verified.standardized ?? null,
            raw: outcome.verified.raw as Json,
          },
        });
        break;
      case "dnc_skipped":
        summary.dncSkipped = (summary.dncSkipped ?? 0) + 1;
        await persistItem({
          status: "skipped",
          error_class: "dnc_locked",
          error_message:
            "Skipped at the paid boundary because the property is permanently DNC.",
        });
        break;
      case "provider_off":
        summary.providerOff++;
        await persistItem({
          status: "skipped",
          error_class: "configuration",
          error_message: "Address verifier disabled",
        });
        break;
      case "not_found":
        summary.failed++;
        await persistItem({
          status: "error",
          error_class: "database",
          error_message: "Property not found",
        });
        break;
    }

    if (
      (i + 1) % PROGRESS_UPDATE_INTERVAL === 0 ||
      i === params.propertyIds.length - 1
    ) {
      await supabase
        .from("jobs")
        .update({
          processed_items: params.processedBefore + i + 1,
          succeeded_items:
            summary.verified + summary.invalid + summary.ambiguous,
          failed_items: summary.failed,
          worker_heartbeat_at: new Date().toISOString(),
        })
        .eq("id", params.jobId);
    }
  }

  return summary;
}

/**
 * Write the terminal status + result_summary and notify the initiator.
 * Status rules unchanged from the legacy single-shot loop.
 */
export async function finalizeCassJob(
  supabase: SupabaseClient<Database>,
  params: { jobId: string; summary: CassJobSummary },
): Promise<void> {
  const { summary } = params;

  // "failed" status only if every single verification bombed AND at least
  // one real attempt was made. If the provider is off across the board,
  // mark the job "canceled" — it didn't fail, we just can't run it.
  const anyAttempted =
    summary.total - summary.providerOff - (summary.dncSkipped ?? 0) > 0;
  const status: Database["public"]["Tables"]["jobs"]["Update"]["status"] =
    !anyAttempted
      ? "canceled"
      : summary.failed === summary.total
        ? "failed"
        : summary.failed > 0
          ? "partial"
          : "completed";

  await supabase
    .from("jobs")
    .update({
      status,
      processed_items: summary.total,
      succeeded_items: summary.verified + summary.invalid + summary.ambiguous,
      failed_items: summary.failed,
      completed_at: new Date().toISOString(),
      result_summary: {
        ...summary,
      },
      error_message: status === "canceled" ? "Address verifier disabled" : null,
    })
    .eq("id", params.jobId);

  // Feature 7 — notify the user who kicked the job off. Best-effort;
  // must not fail the enrichment loop if the notification write blows up.
  try {
    await dispatchJobCompleted(supabase, { jobId: params.jobId });
  } catch (e) {
    reportError(e, {
      tags: { surface: "cass_job_notification_dispatch" },
      extra: { jobId: params.jobId },
    });
  }
}

/**
 * Drive the CASS enrichment of one child job to completion in a SINGLE
 * invocation: begin → one full-size chunk → finalize.
 *
 * ⚠️ Only safe for bounded batches (import auto-trigger, capped by
 * CASS_AUTOTRIGGER_MAX_ITEMS). Anything user-sized must go through the
 * cass-bulk workflow (src/workflows/cass-bulk.ts), which chunks the IDs
 * across separate function invocations — a single invocation dies at the
 * platform's 5-minute ceiling (~1.8K rows), which is exactly how the
 * 2026-06-11 11,134-row bulk verify stalled.
 *
 * Provider/row outcomes are absorbed into the job summary. Authorization
 * claim failures throw before any paid work so a fabricated or replayed job
 * cannot reach the provider.
 */
export async function runCassEnrichment(
  supabase: SupabaseClient<Database>,
  params: {
    jobId: string;
    propertyIds: string[];
    expectedOrgId: string;
    claimToken?: string | null;
  },
): Promise<CassJobSummary> {
  const summary: CassJobSummary = {
    total: params.propertyIds.length,
    verified: 0,
    invalid: 0,
    ambiguous: 0,
    cacheHits: 0,
    failed: 0,
    providerOff: 0,
    dncSkipped: 0,
    retryableFailures: 0,
    savedResultFailures: 0,
    manualReconciliation: 0,
  };

  await claimAuthorizedCassJobStart(supabase, {
    jobId: params.jobId,
    orgId: params.expectedOrgId,
    claimToken: params.claimToken,
  });

  await runCassChunk(supabase, {
    jobId: params.jobId,
    propertyIds: params.propertyIds,
    processedBefore: 0,
    summary,
    expectedOrgId: params.expectedOrgId,
  });

  await finalizeCassJob(supabase, { jobId: params.jobId, summary });

  return summary;
}
