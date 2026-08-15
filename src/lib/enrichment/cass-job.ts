import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { dispatchJobCompleted } from "@/lib/notifications/dispatch";
import type { Database } from "@/lib/supabase/types";
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
};

const PROGRESS_UPDATE_INTERVAL = 10;
const DEFAULT_AUTOTRIGGER_CAP = 100;

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
): Promise<string[]> {
  const { data: items } = await supabase
    .from("job_items")
    .select("property_id")
    .eq("job_id", parentJobId)
    .in("status", ["success", "skipped"])
    .not("property_id", "is", null);

  const candidateIds = (items ?? [])
    .map((r) => r.property_id)
    .filter((id): id is string => typeof id === "string");
  if (candidateIds.length === 0) return [];

  const { data: rows } = await supabase
    .from("properties")
    .select("id")
    .in("id", candidateIds)
    .eq("cass_status", "unverified");

  return (rows ?? [])
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string");
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
    propertyIds: string[];
    autoStart: boolean;
    blockedReason?: string;
  },
): Promise<string> {
  const resultSummary = params.autoStart
    ? null
    : { awaiting_manual_start: true, reason: params.blockedReason ?? null };

  const { data, error } = await supabase
    .from("jobs")
    .insert({
      type: "cass_dsf2_ncoa",
      status: "queued",
      parent_job_id: params.parentJobId,
      related_import_id: params.relatedImportId,
      created_by: params.createdBy,
      total_items: params.propertyIds.length,
      title: `CASS verify ${params.propertyIds.length} propert${params.propertyIds.length === 1 ? "y" : "ies"}`,
      description: params.autoStart
        ? "Auto-triggered after CSV import"
        : `Awaiting manual start (${params.blockedReason ?? "budget cap"})`,
      provider: "smartystreets",
      input_params: { property_ids: params.propertyIds },
      result_summary: resultSummary,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`failed to create cass child job: ${error.message}`);
  }
  return data.id;
}

/**
 * Flip a CASS job to `running` and stamp the heartbeat. Step 0 of the
 * chunked enrichment path; also the head of the single-shot wrapper.
 */
export async function beginCassJob(
  supabase: SupabaseClient<Database>,
  params: { jobId: string; totalItems: number },
): Promise<void> {
  await supabase
    .from("jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      total_items: params.totalItems,
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", params.jobId);
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
  },
): Promise<CassJobSummary> {
  const { summary } = params;

  for (let i = 0; i < params.propertyIds.length; i++) {
    const propertyId = params.propertyIds[i];
    const outcome = await verifyPropertyAddress(supabase, propertyId);

    switch (outcome.status) {
      case "verified":
      case "stored_with_status":
        if (outcome.verified.cassStatus === "verified") summary.verified++;
        else if (outcome.verified.cassStatus === "invalid") summary.invalid++;
        else if (outcome.verified.cassStatus === "ambiguous") summary.ambiguous++;
        if (outcome.cacheHit) summary.cacheHits++;
        await supabase.from("job_items").insert({
          job_id: params.jobId,
          property_id: propertyId,
          status: "success",
        });
        break;
      case "no_result":
      case "failed":
        summary.failed++;
        await supabase.from("job_items").insert({
          job_id: params.jobId,
          property_id: propertyId,
          status: "error",
          error_class: outcome.status === "no_result" ? "provider" : "database",
          error_message:
            outcome.status === "failed"
              ? outcome.error
              : "Provider returned no result",
        });
        break;
      case "provider_off":
        summary.providerOff++;
        await supabase.from("job_items").insert({
          job_id: params.jobId,
          property_id: propertyId,
          status: "skipped",
          error_class: "configuration",
          error_message: "Address verifier disabled",
        });
        break;
      case "not_found":
        summary.failed++;
        await supabase.from("job_items").insert({
          job_id: params.jobId,
          property_id: propertyId,
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
          succeeded_items: summary.verified + summary.invalid + summary.ambiguous,
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
  const anyAttempted = summary.total - summary.providerOff > 0;
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
      error_message:
        status === "canceled" ? "Address verifier disabled" : null,
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
 * Never throws — job failures are absorbed and reflected in
 * `result_summary` / `error_message` so the /jobs page stays truthful.
 */
export async function runCassEnrichment(
  supabase: SupabaseClient<Database>,
  params: {
    jobId: string;
    propertyIds: string[];
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
  };

  await beginCassJob(supabase, {
    jobId: params.jobId,
    totalItems: params.propertyIds.length,
  });

  await runCassChunk(supabase, {
    jobId: params.jobId,
    propertyIds: params.propertyIds,
    processedBefore: 0,
    summary,
  });

  await finalizeCassJob(supabase, { jobId: params.jobId, summary });

  return summary;
}
