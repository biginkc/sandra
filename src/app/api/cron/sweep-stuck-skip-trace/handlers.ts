import { NextResponse } from "next/server";
import { cronResponseFailed, runMonitoredCron } from "@/lib/errors/cron-monitor";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { start } from "workflow/api";
import * as Sentry from "@sentry/nextjs";

// Finalizing a 4,000-row part takes ~10+ min of sequential DB writes —
// far past the default function window (the 2026-06-12 recovery passes
// were killed mid-loop). 800s is the platform ceiling; combined with
// resumable finalize, each invocation makes maximal progress and the
// next re-claim finishes the remainder.

import { reportError } from "@/lib/errors/report";
import { ensureSentryServerClient } from "@/lib/errors/sentry-server-client";
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
const NONPROGRESS_AGE_MS = 15 * 60 * 1000;
const AMBIGUOUS_SIGNAL = "skiptrace_submission_unknown";
const LONG_RUNNING_SIGNAL = "skiptrace_long_running";

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

  return runMonitoredCron(
    "sandra-skiptrace-sweep",
    {
      schedule: { type: "crontab", value: "*/1 * * * *" },
      checkinMargin: 1,
      maxRuntime: 14,
    },
    async () => {
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
    },
    async (response) => {
      if (await cronResponseFailed(response)) return true;
      const summary = await response.clone().json() as SweepSummary & { ok: boolean };
      return summary.errors > 0;
    },
  );
}

export type SweepSummary = {
  candidates: number;
  unsubmitted_reclaimed: number;
  finalized: number;
  still_pending: number;
  errors: number;
  ambiguous_submissions: number;
  long_running: number;
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

async function observeSignal(
  supabase: SweepClient,
  kind: string,
  sourceId: string,
  active: boolean,
): Promise<void> {
  const { data, error } = await supabase.rpc("observe_sentry_anomaly", {
    p_signal_kind: kind,
    p_source_id: sourceId,
    p_is_active: active,
  });
  if (error) throw error;
  const claim = data && typeof data === "object" && !Array.isArray(data)
    ? data as { decision?: unknown; claim_token?: unknown } : null;
  if (!claim || typeof claim.claim_token !== "string") return;
  let delivered = false;
  try {
    if (ensureSentryServerClient()) {
      if (claim.decision === "new" || claim.decision === "repeat") {
        reportError(new Error(`Sandra operational state: ${kind}`), {
          tags: { surface: "cron_skiptrace_state_observer", kind: "state", operation: kind, outcome: "active" },
        });
      } else if (claim.decision === "recovered") {
        reportError(new Error(`Sandra operational state recovered: ${kind}`), {
          tags: { surface: "cron_skiptrace_state_observer", kind: "state", operation: kind, outcome: "recovered" },
        });
      }
      delivered = await Sentry.flush(2_000);
    }
  } finally {
    const { error: ackError } = await supabase.rpc("ack_sentry_anomaly", {
      p_signal_kind: kind,
      p_source_id: sourceId,
      p_claim_token: claim.claim_token,
      p_delivered: delivered,
    });
    if (ackError) throw ackError;
  }
}

async function observeSkiptraceRecovery(supabase: SweepClient, cutoffMs: number) {
  for (const kind of [AMBIGUOUS_SIGNAL, LONG_RUNNING_SIGNAL]) {
    const { data, error } = await supabase.from("sentry_anomaly_ledger")
      .select("source_id")
      .eq("signal_kind", kind)
      .eq("is_active", true)
      .order("last_observed_at", { ascending: true })
      .limit(PER_TICK_LIMIT);
    if (error) throw error;
    for (const row of data ?? []) {
      const { data: job, error: jobError } = await supabase.from("jobs")
        .select("status,provider_run_id,created_at,started_at,result_summary")
        .eq("id", row.source_id).maybeSingle();
      if (jobError) throw jobError;
      const active = kind === AMBIGUOUS_SIGNAL
        ? !!job && ["queued", "running"].includes(job.status) && !job.provider_run_id
          && isSubmissionUnknown(job.result_summary) && isBeforeCutoff(job.created_at, cutoffMs)
        : !!job && job.status === "running" && !!job.provider_run_id
          && isBeforeCutoff(job.started_at, cutoffMs);
      // Refresh last_observed_at even while active, so ordering rotates
      // through a backlog larger than this tick's bounded page.
      await observeSignal(supabase, kind, row.source_id, active);
    }
  }
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
  // Observe business age independently of the recovery heartbeat. A submit
  // whose provider outcome is unknown must never be automatically re-sent.
  const nonprogressCutoff = new Date(Date.now() - NONPROGRESS_AGE_MS).toISOString();
  const { data: ambiguous, error: ambiguousError } = await supabase
    .from("jobs")
    .select("id")
    .eq("type", "skip_trace")
    .in("status", ["queued", "running"])
    .is("provider_run_id", null)
    .eq("result_summary->>submit_phase", "submitting")
    .lt("created_at", nonprogressCutoff)
    .order("created_at", { ascending: true })
    .limit(PER_TICK_LIMIT);
  if (ambiguousError) {
    throw new Error(`observe ambiguous skip-trace submissions failed: ${ambiguousError.message}`);
  }
  // Telemetry failure cannot block recovery or cause another paid submit.
  try {
    for (const job of ambiguous ?? []) {
      await observeSignal(supabase, AMBIGUOUS_SIGNAL, job.id, true);
    }
    await observeSkiptraceRecovery(supabase, Date.parse(nonprogressCutoff));
  } catch (observerError) {
    reportError(observerError, { tags: { surface: "cron_skiptrace_state_observer_failure" } });
  }
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
    // Provider is feature-flagged off — nothing to poll, but old durable
    // running rows remain observable rather than silently disappearing.
    const oldRunning = (stuck ?? []).filter((job) =>
      isBeforeCutoff(job.started_at, Date.parse(nonprogressCutoff)));
    for (const job of oldRunning) {
      try { await observeSignal(supabase, LONG_RUNNING_SIGNAL, job.id, true); }
      catch (observerError) { reportError(observerError, { tags: { surface: "cron_skiptrace_state_observer_failure" } }); }
    }
    return {
      candidates: (stuck?.length ?? 0) + unsubmitted.candidates,
      unsubmitted_reclaimed: unsubmitted.reclaimed,
      finalized: 0,
      still_pending: 0,
      errors: unsubmitted.errors,
      ambiguous_submissions: ambiguous?.length ?? 0,
      long_running: oldRunning.length,
    };
  }

  let finalized = 0;
  let stillPending = 0;
  let longRunning = 0;
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
        if (isBeforeCutoff(job.started_at, Date.parse(nonprogressCutoff))) {
          longRunning++;
          try { await observeSignal(supabase, LONG_RUNNING_SIGNAL, job.id, true); }
          catch (observerError) { reportError(observerError, { tags: { surface: "cron_skiptrace_state_observer_failure" } }); }
        }
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
        if (isBeforeCutoff(job.started_at, Date.parse(nonprogressCutoff))) longRunning++;
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
    ambiguous_submissions: ambiguous?.length ?? 0,
    long_running: longRunning,
  };
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
