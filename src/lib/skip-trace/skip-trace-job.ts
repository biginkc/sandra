import type { SupabaseClient } from "@supabase/supabase-js";

import { ConfigurationError, ProviderError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";
import { dispatchJobCompleted } from "@/lib/notifications/dispatch";
import type { Database, Json } from "@/lib/supabase/types";

import { normalizeAddress, readCache, writeCache } from "./cache";
import { persistSkipTraceResult, type PersistOutcome } from "./persist-result";
import { getSkipTraceProvider } from "./registry";
import type { SkipTraceInput, SkipTraceResult } from "./types";

/**
 * Drive a skip-trace job to completion (or to a `running` state with a
 * pending batch queueId, when the work is large enough to justify the
 * async path).
 *
 * Mirrors `runCassEnrichment` in shape but splits two ways:
 *   - sync:  ≤1 miss → POST /trace/lookup/, persist, mark complete
 *   - async: ≥2 misses → POST /trace/, store queue_id, exit. Webhook
 *            (or polling) finalizes via `finalizeSkipTraceFromBatch`.
 *
 * Cache reads happen first; cached rows never hit the provider.
 *
 * Never throws — errors are absorbed into the job row + reported.
 */

export type SkipTraceJobSummary = {
  total: number;
  matched: number;
  no_match: number;
  failed: number;
  cached_hits: number;
  api_hits: number;
  total_credits: number;
};

export async function runSkipTraceEnrichment(
  supabase: SupabaseClient<Database>,
  params: { jobId: string; propertyIds: string[] },
): Promise<SkipTraceJobSummary | { pending: true; queueId: string }> {
  const summary: SkipTraceJobSummary = {
    total: params.propertyIds.length,
    matched: 0,
    no_match: 0,
    failed: 0,
    cached_hits: 0,
    api_hits: 0,
    total_credits: 0,
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

  // ------------------------------------------------------------------
  // 0. Resolve provider
  // ------------------------------------------------------------------
  let provider;
  try {
    provider = getSkipTraceProvider();
  } catch (e) {
    if (e instanceof ConfigurationError) {
      await markJobCanceled(supabase, params.jobId, e.message);
      return summary;
    }
    throw e;
  }
  if (!provider) {
    await markJobCanceled(supabase, params.jobId, "Skip-trace provider disabled");
    return summary;
  }

  // ------------------------------------------------------------------
  // 1. Load properties + check cache. Build:
  //    - cachedResults: results we can persist immediately
  //    - misses: properties needing a real provider call
  // ------------------------------------------------------------------
  const { data: properties } = await supabase
    .from("properties")
    .select("id, address, city, state, zip")
    .in("id", params.propertyIds);

  if (!properties || properties.length === 0) {
    await markJobFailed(supabase, params.jobId, "No properties found");
    return summary;
  }

  const cachedResults: SkipTraceResult[] = [];
  const misses: SkipTraceInput[] = [];
  const propsById = new Map(properties.map((p) => [p.id, p]));

  for (const propertyId of params.propertyIds) {
    const p = propsById.get(propertyId);
    if (!p) {
      summary.failed++;
      await insertJobItem(supabase, params.jobId, propertyId, {
        status: "error",
        error_class: "database",
        error_message: "Property not found",
      });
      continue;
    }
    const addressNormalized = normalizeAddress({
      address: p.address,
      city: p.city,
      state: p.state,
      zip: p.zip,
    });
    const cached = await readCache(supabase, provider.providerId, addressNormalized);
    if (cached) {
      // Cache row stores the previous result; reuse it but rewrite the
      // propertyId so persistence targets the *current* row.
      cachedResults.push({ ...cached.result, propertyId });
      summary.cached_hits++;
    } else {
      misses.push({
        propertyId,
        address: p.address,
        city: p.city ?? "",
        state: p.state,
        zip: p.zip ?? null,
      });
    }
  }

  // ------------------------------------------------------------------
  // 2. Persist cached hits first (fast, no API calls).
  // ------------------------------------------------------------------
  for (const result of cachedResults) {
    await persistAndRecord(supabase, params.jobId, result, summary, /*fromCache*/ true);
  }

  // ------------------------------------------------------------------
  // 3. Decide path for misses: 0 / 1-sync / N-async
  // ------------------------------------------------------------------
  if (misses.length === 0) {
    await finalizeJob(supabase, params.jobId, summary);
    return summary;
  }

  if (misses.length === 1) {
    try {
      const result = await provider.lookupSingle(misses[0]);
      await persistAndRecord(supabase, params.jobId, result, summary, /*fromCache*/ false);
      await writeCache(
        supabase,
        provider.providerId,
        normalizeAddress({
          address: misses[0].address,
          city: misses[0].city,
          state: misses[0].state,
          zip: misses[0].zip,
        }),
        result,
      );
    } catch (e) {
      summary.failed++;
      const msg = e instanceof Error ? e.message : String(e);
      const klass = e instanceof ProviderError ? "provider" : "database";
      await insertJobItem(supabase, params.jobId, misses[0].propertyId, {
        status: "error",
        error_class: klass,
        error_message: msg,
      });
      reportError(e, {
        tags: { surface: "skip_trace_lookup_single" },
        extra: { propertyId: misses[0].propertyId, jobId: params.jobId },
      });
    }
    await finalizeJob(supabase, params.jobId, summary);
    return summary;
  }

  // misses.length >= 2 → async batch
  try {
    const ticket = await provider.submitBatch(misses);
    await supabase
      .from("jobs")
      .update({
        provider_run_id: ticket.queueId,
        worker_heartbeat_at: new Date().toISOString(),
        result_summary: {
          ...summary,
          batch_pending: true,
          estimated_wait_seconds: ticket.estimatedWaitSeconds,
          credits_per_lead: ticket.creditsPerLead,
        } as unknown as Json,
      })
      .eq("id", params.jobId);
    return { pending: true, queueId: ticket.queueId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markJobFailed(supabase, params.jobId, `submitBatch failed: ${msg}`);
    reportError(e, {
      tags: { surface: "skip_trace_submit_batch" },
      extra: { jobId: params.jobId, count: misses.length },
    });
    return summary;
  }
}

/**
 * Finalize a job whose batch results just arrived (via webhook or
 * polling). Iterates each result, persists, writes cache, updates job
 * progress, transitions to terminal status, dispatches notification.
 */
export async function finalizeSkipTraceFromBatch(
  supabase: SupabaseClient<Database>,
  params: { jobId: string; results: SkipTraceResult[] },
): Promise<SkipTraceJobSummary> {
  // Resume the existing summary if present so cached_hits etc. carry forward.
  const { data: jobRow } = await supabase
    .from("jobs")
    .select("result_summary")
    .eq("id", params.jobId)
    .maybeSingle();

  const prior = (jobRow?.result_summary ?? {}) as Partial<SkipTraceJobSummary> & {
    batch_pending?: boolean;
  };

  const summary: SkipTraceJobSummary = {
    total: prior.total ?? params.results.length,
    matched: prior.matched ?? 0,
    no_match: prior.no_match ?? 0,
    failed: prior.failed ?? 0,
    cached_hits: prior.cached_hits ?? 0,
    api_hits: prior.api_hits ?? 0,
    total_credits: prior.total_credits ?? 0,
  };

  // Resolve provider once for cache writes.
  const provider = getSkipTraceProvider();
  const providerId = provider?.providerId ?? "tracerfy";

  // We need property addresses for cache keys.
  const propertyIds = params.results.map((r) => r.propertyId).filter(Boolean);
  const { data: props } = await supabase
    .from("properties")
    .select("id, address, city, state, zip")
    .in("id", propertyIds);
  const propsById = new Map((props ?? []).map((p) => [p.id, p]));

  for (const result of params.results) {
    await persistAndRecord(supabase, params.jobId, result, summary, /*fromCache*/ false);
    const p = propsById.get(result.propertyId);
    if (p) {
      await writeCache(
        supabase,
        providerId,
        normalizeAddress({
          address: p.address,
          city: p.city,
          state: p.state,
          zip: p.zip,
        }),
        result,
      );
    }
  }

  await finalizeJob(supabase, params.jobId, summary);
  return summary;
}

// ---------- helpers ----------------------------------------------------

async function persistAndRecord(
  supabase: SupabaseClient<Database>,
  jobId: string,
  result: SkipTraceResult,
  summary: SkipTraceJobSummary,
  fromCache: boolean,
): Promise<void> {
  let outcome: PersistOutcome;
  try {
    outcome = await persistSkipTraceResult(supabase, result);
  } catch (e) {
    summary.failed++;
    const msg = e instanceof Error ? e.message : String(e);
    await insertJobItem(supabase, jobId, result.propertyId, {
      status: "error",
      error_class: "database",
      error_message: msg,
    });
    reportError(e, {
      tags: { surface: "skip_trace_persist" },
      extra: { jobId, propertyId: result.propertyId },
    });
    return;
  }

  if (!fromCache) summary.api_hits++;
  summary.total_credits += result.creditsDeducted;

  if (outcome.status === "matched") {
    summary.matched++;
    await insertJobItem(supabase, jobId, result.propertyId, {
      status: "success",
      result: {
        from_cache: fromCache,
        credits_deducted: result.creditsDeducted,
        phones_added: outcome.phonesAdded,
        emails_added: outcome.emailsAdded,
      },
    });
  } else if (outcome.status === "no_match") {
    summary.no_match++;
    await insertJobItem(supabase, jobId, result.propertyId, {
      status: "success",
      result: {
        from_cache: fromCache,
        credits_deducted: result.creditsDeducted,
        no_match: true,
      },
    });
  } else {
    summary.failed++;
    await insertJobItem(supabase, jobId, result.propertyId, {
      status: "error",
      error_class: "database",
      error_message: "Property not found at persist time",
    });
  }
}

async function insertJobItem(
  supabase: SupabaseClient<Database>,
  jobId: string,
  propertyId: string,
  fields: {
    status: "success" | "error" | "skipped";
    error_class?: "database" | "provider" | "configuration" | "validation" | "transient" | "authorization";
    error_message?: string;
    result?: Record<string, unknown>;
  },
): Promise<void> {
  await supabase.from("job_items").insert({
    job_id: jobId,
    property_id: propertyId,
    status: fields.status,
    error_class: fields.error_class ?? null,
    error_message: fields.error_message ?? null,
    output_payload: (fields.result ?? null) as unknown as Json,
  });
}

async function finalizeJob(
  supabase: SupabaseClient<Database>,
  jobId: string,
  summary: SkipTraceJobSummary,
): Promise<void> {
  const status: Database["public"]["Tables"]["jobs"]["Update"]["status"] =
    summary.failed === 0
      ? "completed"
      : summary.matched + summary.no_match === 0
        ? "failed"
        : "partial";

  await supabase
    .from("jobs")
    .update({
      status,
      processed_items: summary.total,
      succeeded_items: summary.matched + summary.no_match,
      failed_items: summary.failed,
      completed_at: new Date().toISOString(),
      result_summary: summary as unknown as Json,
    })
    .eq("id", jobId);

  try {
    await dispatchJobCompleted(supabase, { jobId });
  } catch (e) {
    reportError(e, {
      tags: { surface: "skip_trace_job_notification_dispatch" },
      extra: { jobId },
    });
  }
}

async function markJobCanceled(
  supabase: SupabaseClient<Database>,
  jobId: string,
  reason: string,
): Promise<void> {
  await supabase
    .from("jobs")
    .update({
      status: "canceled",
      completed_at: new Date().toISOString(),
      error_message: reason,
    })
    .eq("id", jobId);
}

async function markJobFailed(
  supabase: SupabaseClient<Database>,
  jobId: string,
  reason: string,
): Promise<void> {
  await supabase
    .from("jobs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: reason,
    })
    .eq("id", jobId);
}
