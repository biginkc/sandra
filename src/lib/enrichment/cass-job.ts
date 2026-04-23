import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { dispatchJobCompleted } from "@/lib/notifications/dispatch";
import type { Database } from "@/lib/supabase/types";
import { verifyPropertyAddress } from "./verify-property";

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
export const CASS_COST_PER_LOOKUP_USD = 0.03;

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
 * Drive the CASS enrichment of one child job to completion. Iterates the
 * given property IDs, calling `verifyPropertyAddress` (cache-through) for
 * each, updating job progress every N rows and setting a final status.
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

  await supabase
    .from("jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      total_items: params.propertyIds.length,
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", params.jobId);

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
          processed_items: i + 1,
          succeeded_items: summary.verified + summary.invalid + summary.ambiguous,
          failed_items: summary.failed,
          worker_heartbeat_at: new Date().toISOString(),
        })
        .eq("id", params.jobId);
    }
  }

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
      processed_items: params.propertyIds.length,
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

  return summary;
}
