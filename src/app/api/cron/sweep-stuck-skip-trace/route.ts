import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { start } from "workflow/api";

// Finalizing a 4,000-row part takes ~10+ min of sequential DB writes —
// far past the default function window (the 2026-06-12 recovery passes
// were killed mid-loop). 800s is the platform ceiling; combined with
// resumable finalize, each invocation makes maximal progress and the
// next re-claim finishes the remainder.
export const maxDuration = 800;

import { reportError } from "@/lib/errors/report";
import { getSkipTraceProvider } from "@/lib/skip-trace/registry";
import { finalizeSkipTraceFromBatch } from "@/lib/skip-trace/skip-trace-job";
import type { Database } from "@/lib/supabase/types";
import { skipTraceSubmitWorkflow } from "@/workflows/skip-trace-submit";

/**
 * Vercel cron → `/api/cron/sweep-stuck-skip-trace` every 5 minutes.
 *
 * Tracerfy (and every other batch skip-trace provider we'd plug in) is
 * async: we submit, get a queue_id, mark the job `running`, and wait for
 * a webhook to deliver results. Webhooks are best-effort — they fail
 * occasionally for predictable reasons (provider retry exhaustion,
 * transient network blips, deploy races). When that happens, the job
 * sits in `running` forever and someone has to notice.
 *
 * This endpoint is the catch-up. For jobs that never reached Tracerfy
 * (provider_run_id is null), it atomically claims the stale row and
 * starts the durable submit workflow. For jobs already submitted
 * (provider_run_id is set), it polls the provider directly. If the batch
 * finished, we finalize. If it's still pending, we just bump the heartbeat
 * so the row doesn't look orphaned and try again next tick.
 *
 * Returns a summary so the cron dashboard can reason about health
 * at a glance.
 */

// Give the webhook a fair chance to land before sweeping. Tracerfy's
// typical batch wait is 30s–few min; this also avoids polling a job
// whose results are about to arrive anyway.
const MIN_AGE_BEFORE_SWEEP_MS = 2 * 60 * 1000;

// Per-tick budget to avoid touching too many jobs in a single function
// invocation. In practice we expect 0–1 stuck jobs per tick; a cap is
// belt-and-braces.
const PER_TICK_LIMIT = 25;

function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "sweep-stuck-skip-trace cron needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createSupabaseClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createServiceRoleClient();
    const summary = await runSweep(supabase);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    reportError(e, { tags: { surface: "cron_sweep_stuck_skip_trace" } });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}

export type SweepSummary = {
  candidates: number;
  unsubmitted_reclaimed: number;
  finalized: number;
  still_pending: number;
  errors: number;
};

/**
 * Exported separately from the route so integration tests can drive it
 * against the test Supabase without constructing an HTTP request.
 * Production always goes through `handle()`.
 */
// A finalizer that died mid-run (deploy, crash, function max-duration
// kill) leaves its job stranded in 'finalizing'. The finalize loop bumps
// the heartbeat every ~250 rows (~50s at observed row rates), so a
// 5-minute-stale heartbeat means the worker is gone — hand the job back
// to 'running' so a later tick re-claims it. Finalize is resumable (it
// skips properties already in job_items), so re-claims converge instead
// of re-writing from scratch.
const STALE_FINALIZING_MS = 5 * 60 * 1000;

type SweepClient = ReturnType<typeof createServiceRoleClient>;

function isBeforeCutoff(value: string | null, cutoffMs: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && parsed < cutoffMs;
}

function isSubmissionUnknown(resultSummary: unknown): boolean {
  return (
    !!resultSummary &&
    typeof resultSummary === "object" &&
    !Array.isArray(resultSummary) &&
    (resultSummary as Record<string, unknown>).submit_phase === "submitting"
  );
}

async function reclaimUnsubmittedSkipTraceJobs(
  supabase: SweepClient,
  cutoff: string,
): Promise<{ candidates: number; reclaimed: number; errors: number }> {
  const cutoffMs = Date.parse(cutoff);
  const { data: unsubmitted, error } = await supabase
    .from("jobs")
    .select("id, org_id, status, worker_heartbeat_at, created_at, result_summary")
    .eq("type", "skip_trace")
    .in("status", ["queued", "running"])
    .is("provider_run_id", null)
    .or(`worker_heartbeat_at.is.null,worker_heartbeat_at.lt.${cutoff}`)
    .order("created_at", { ascending: true })
    .limit(PER_TICK_LIMIT);

  if (error) {
    throw new Error(
      `fetch unsubmitted skip-trace jobs failed: ${error.message}`,
    );
  }

  let reclaimed = 0;
  let errors = 0;
  const candidates = (unsubmitted ?? []).filter((job) => {
    const staleByHeartbeat = job.worker_heartbeat_at
      ? isBeforeCutoff(job.worker_heartbeat_at, cutoffMs)
      : isBeforeCutoff(job.created_at, cutoffMs);
    if (!staleByHeartbeat) return false;
    // Once a submitter has crossed the paid provider boundary, automatic
    // re-submit is not safe without a provider idempotency key. Leave the
    // row for manual reconciliation instead of risking duplicate spend.
    if (isSubmissionUnknown(job.result_summary)) return false;
    return true;
  });

  for (const job of candidates) {
    try {
      await start(skipTraceSubmitWorkflow, [
        { jobId: job.id, orgId: job.org_id },
      ]);
      reclaimed++;
    } catch (e) {
      reportError(e, {
        tags: { surface: "cron_sweep_unsubmitted_skip_trace_start" },
        extra: { jobId: job.id },
      });
      errors++;
      continue;
    }
  }

  return {
    candidates: candidates.length,
    reclaimed,
    errors,
  };
}

export async function runSweep(
  supabase: SweepClient,
): Promise<SweepSummary> {
  const staleFinalizingCutoff = new Date(
    Date.now() - STALE_FINALIZING_MS,
  ).toISOString();
  const { error: rescueErr } = await supabase
    .from("jobs")
    .update({ status: "running" })
    .eq("type", "skip_trace")
    .eq("status", "finalizing")
    .lt("worker_heartbeat_at", staleFinalizingCutoff);
  if (rescueErr) {
    reportError(rescueErr, {
      tags: { surface: "cron_sweep_stale_finalizing_rescue" },
    });
  }

  const cutoff = new Date(Date.now() - MIN_AGE_BEFORE_SWEEP_MS).toISOString();

  const unsubmitted = await reclaimUnsubmittedSkipTraceJobs(supabase, cutoff);

  const { data: stuck, error } = await supabase
    .from("jobs")
    .select("id, provider, provider_run_id, started_at, worker_heartbeat_at")
    .eq("type", "skip_trace")
    .eq("status", "running")
    .not("provider_run_id", "is", null)
    .lt("started_at", cutoff)
    .order("started_at", { ascending: true })
    .limit(PER_TICK_LIMIT);

  if (error) throw new Error(`fetch stuck skip-trace jobs failed: ${error.message}`);

  const provider = getSkipTraceProvider();
  if (!provider) {
    // Provider is feature-flagged off — nothing to poll.
    return {
      candidates: (stuck?.length ?? 0) + unsubmitted.candidates,
      unsubmitted_reclaimed: unsubmitted.reclaimed,
      finalized: 0,
      still_pending: 0,
      errors: unsubmitted.errors,
    };
  }

  let finalized = 0;
  let stillPending = 0;
  let errors = 0;
  for (const job of stuck ?? []) {
    if (!job.provider_run_id) continue;
    try {
      const results = await provider.pollBatch(job.provider_run_id);
      if (!results) {
        // Still pending at the provider — refresh the heartbeat so the
        // row doesn't look orphaned, try again on the next tick.
        await supabase
          .from("jobs")
          .update({ worker_heartbeat_at: new Date().toISOString() })
          .eq("id", job.id);
        stillPending++;
        continue;
      }
      const outcome = await finalizeSkipTraceFromBatch(supabase, {
        jobId: job.id,
        results,
      });
      if (outcome === null) {
        // Lost the claim — another finalizer (webhook, or an
        // overlapping tick) owns this job. Not our work to count.
        stillPending++;
      } else {
        finalized++;
      }
    } catch (e) {
      reportError(e, {
        tags: { surface: "cron_sweep_stuck_skip_trace_per_job" },
        extra: { jobId: job.id, queueId: job.provider_run_id },
      });
      errors++;
    }
  }

  return {
    candidates: (stuck?.length ?? 0) + unsubmitted.candidates,
    unsubmitted_reclaimed: unsubmitted.reclaimed,
    finalized,
    still_pending: stillPending,
    errors: errors + unsubmitted.errors,
  };
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
