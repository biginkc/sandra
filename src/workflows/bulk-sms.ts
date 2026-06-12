/**
 * Bulk SMS queueing workflow — Vercel Workflow DevKit version.
 *
 * Large Bulk SMS selections (e.g. tonight's 9,316-prospect pool) can't
 * run the queueing loop in one server-action invocation: 4–6 DB round
 * trips per property ≈ 100–200ms/row puts anything past ~2.5K rows over
 * the platform's 5-minute function ceiling — the same failure class
 * fixed for CASS (#240) and skip-trace (#241).
 *
 * Same shape as cass-bulk.ts:
 *   1. loadBulkSmsJob   — read property_ids + opts off the job row,
 *                          flip it to running
 *   2. bulkSmsChunkStep — queue one slice via queueSmsBatch; the
 *                          schedule state (pacing offsets, daily-cap
 *                          bucket, counters) threads between chunks so
 *                          a chunked run schedules identically to one
 *                          long loop
 *   3. finalize         — terminal status + result_summary
 *
 * Queue inserts are idempotent-enough for WDK retry semantics: a chunk
 * that dies mid-slice re-runs, and re-queued duplicates for the same
 * property surface in the Outbox where the operator can see them — the
 * release path re-checks consent and quiet hours per message regardless.
 */

import type {
  BulkSmsQueueOpts,
  BulkSmsScheduleState,
} from "@/lib/messaging/bulk-queue";
import { createAdminClient } from "@/lib/supabase/admin";

/* The queueing library's import graph reaches node:crypto (template-pool
 * hashing, provider HMAC verification) — Node built-ins are banned in the
 * sandboxed workflow-function bundle, so the library is loaded with a
 * dynamic import INSIDE the steps (steps run in full Node).
 * See https://useworkflow.dev/err/node-js-module-in-workflow */

/** Rows per chunk step. ~150ms/row worst case ≈ 30s per invocation. */
const CHUNK_SIZE = 200;

export type BulkSmsWorkflowParams = {
  /** Job row (type bulk_sms) whose input_params carry the batch. */
  jobId: string;
};

type LoadedBulkSmsJob = {
  propertyIds: string[];
  opts: BulkSmsQueueOpts;
  enrolledByUserId: string | null;
  initialState: BulkSmsScheduleState;
};

/** STEP 1 — Read the batch off the job row and flip it to running. */
async function loadBulkSmsJob(jobId: string): Promise<LoadedBulkSmsJob> {
  "use step";

  const supabase = createAdminClient();

  const { data: job, error } = await supabase
    .from("jobs")
    .select("input_params")
    .eq("id", jobId)
    .single();

  if (error || !job) {
    throw new Error(
      `bulk-sms workflow: job ${jobId} not found: ${error?.message ?? "no row"}`,
    );
  }

  const params = job.input_params as {
    property_ids?: unknown;
    opts?: BulkSmsQueueOpts;
    enrolled_by_user_id?: string | null;
    anchor_ms?: number;
  } | null;

  const raw = params?.property_ids ?? null;
  const propertyIds = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];

  if (propertyIds.length === 0) {
    throw new Error(
      `bulk-sms workflow: job ${jobId} has no property IDs in input_params`,
    );
  }

  await supabase
    .from("jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      total_items: propertyIds.length,
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  const { freshScheduleState } = await import("@/lib/messaging/bulk-queue");
  return {
    propertyIds,
    opts: params?.opts ?? {},
    enrolledByUserId: params?.enrolled_by_user_id ?? null,
    initialState: freshScheduleState(params?.anchor_ms ?? Date.now()),
  };
}

/**
 * STEP 2 — Queue one slice. Runs under the admin client (same privilege
 * level as the cron releaser that will transmit these messages); the
 * release path re-checks consent + quiet hours per message at send time.
 */
async function bulkSmsChunkStep(args: {
  jobId: string;
  propertyIds: string[];
  opts: BulkSmsQueueOpts;
  enrolledByUserId: string | null;
  processedBefore: number;
  state: BulkSmsScheduleState;
}): Promise<BulkSmsScheduleState> {
  "use step";

  const adminClient = createAdminClient();
  const { queueSmsBatch } = await import("@/lib/messaging/bulk-queue");
  const state = await queueSmsBatch(adminClient, adminClient, {
    propertyIds: args.propertyIds,
    opts: args.opts,
    enrolledByUserId: args.enrolledByUserId,
    state: args.state,
  });

  await adminClient
    .from("jobs")
    .update({
      processed_items: args.processedBefore + args.propertyIds.length,
      succeeded_items: state.succeeded,
      failed_items: state.failed.length,
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", args.jobId);

  return state;
}

/** STEP 3 — Terminal status + result_summary. */
async function finalizeBulkSmsStep(args: {
  jobId: string;
  total: number;
  state: BulkSmsScheduleState;
}): Promise<void> {
  "use step";

  const supabase = createAdminClient();
  const { state } = args;
  const status =
    state.failed.length === 0
      ? "completed"
      : state.succeeded > 0
        ? "partial"
        : "failed";

  await supabase
    .from("jobs")
    .update({
      status,
      processed_items: args.total,
      succeeded_items: state.succeeded,
      failed_items: state.failed.length,
      completed_at: new Date().toISOString(),
      result_summary: {
        queued: state.succeeded,
        skipped: state.skipped,
        failed: state.failed.length,
        failed_sample: state.failed.slice(0, 20),
      },
    })
    .eq("id", args.jobId);
}

/** `start(bulkSmsWorkflow, [{ jobId }])` — load → chunk loop → finalize. */
export async function bulkSmsWorkflow(
  params: BulkSmsWorkflowParams,
): Promise<{ queued: number; skipped: number; failed: number }> {
  "use workflow";

  const loaded = await loadBulkSmsJob(params.jobId);

  let state = loaded.initialState;

  for (
    let offset = 0;
    offset < loaded.propertyIds.length;
    offset += CHUNK_SIZE
  ) {
    state = await bulkSmsChunkStep({
      jobId: params.jobId,
      propertyIds: loaded.propertyIds.slice(offset, offset + CHUNK_SIZE),
      opts: loaded.opts,
      enrolledByUserId: loaded.enrolledByUserId,
      processedBefore: offset,
      state,
    });
  }

  await finalizeBulkSmsStep({
    jobId: params.jobId,
    total: loaded.propertyIds.length,
    state,
  });

  return {
    queued: state.succeeded,
    skipped: state.skipped,
    failed: state.failed.length,
  };
}
