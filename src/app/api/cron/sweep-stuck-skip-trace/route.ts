import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { getSkipTraceProvider } from "@/lib/skip-trace/registry";
import { finalizeSkipTraceFromBatch } from "@/lib/skip-trace/skip-trace-job";
import type { Database } from "@/lib/supabase/types";

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
 * This endpoint is the catch-up. For each `skip_trace` job that's been
 * `running` for more than `MIN_AGE_BEFORE_SWEEP_MS` and has a
 * `provider_run_id` set, we poll the provider directly. If the batch
 * finished, we finalize. If it's still pending, we just bump the
 * heartbeat so the row doesn't look orphaned and try again next tick.
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
  finalized: number;
  still_pending: number;
  errors: number;
};

/**
 * Exported separately from the route so integration tests can drive it
 * against the test Supabase without constructing an HTTP request.
 * Production always goes through `handle()`.
 */
export async function runSweep(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<SweepSummary> {
  const cutoff = new Date(Date.now() - MIN_AGE_BEFORE_SWEEP_MS).toISOString();

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
      candidates: stuck?.length ?? 0,
      finalized: 0,
      still_pending: 0,
      errors: 0,
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
      await finalizeSkipTraceFromBatch(supabase, {
        jobId: job.id,
        results,
      });
      finalized++;
    } catch (e) {
      reportError(e, {
        tags: { surface: "cron_sweep_stuck_skip_trace_per_job" },
        extra: { jobId: job.id, queueId: job.provider_run_id },
      });
      errors++;
    }
  }

  return {
    candidates: stuck?.length ?? 0,
    finalized,
    still_pending: stillPending,
    errors,
  };
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
