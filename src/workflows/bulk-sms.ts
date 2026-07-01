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
 *                          schedule state (pacing offsets, counters)
 *                          threads between chunks so a chunked run
 *                          schedules identically to one long loop
 *   3. finalize         — terminal status + result_summary
 *
 * Queue inserts are idempotent-enough for WDK retry semantics: a chunk
 * that dies mid-slice re-runs, and re-queued duplicates for the same
 * property surface in the Outbox where the operator can see them — the
 * release path re-checks consent and quiet hours per message regardless.
 */

import type {
  ResolvedBulkSmsQueueOpts,
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
  opts: ResolvedBulkSmsQueueOpts;
  initialState: BulkSmsScheduleState;
};

type BulkSmsJobFailureArgs = {
  campaignId: string;
  campaignSource: ResolvedBulkSmsQueueOpts["campaignSource"];
  errorMessage: string;
  jobId: string;
  state: BulkSmsScheduleState;
  total: number;
};

async function completeCampaign(
  campaignId: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { data: current, error: currentError } = await supabase
    .from("campaigns")
    .select("status")
    .eq("id", campaignId)
    .maybeSingle();
  if (currentError) {
    throw new Error(`bulk-sms workflow: failed to load campaign ${campaignId}: ${currentError.message}`);
  }
  if (current?.status === "paused") {
    return;
  }

  const { data, error } = await supabase
    .from("campaigns")
    .update({
      status: "completed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId)
    .in("status", ["launching", "completed"])
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`bulk-sms workflow: failed to complete campaign ${campaignId}: ${error.message}`);
  }
  if (!data) {
    throw new Error(`bulk-sms workflow: campaign ${campaignId} is not launchable`);
  }
}

/** STEP 1 — Read the batch off the job row and flip it to running. */
async function loadBulkSmsJob(jobId: string): Promise<LoadedBulkSmsJob> {
  "use step";

  const supabase = createAdminClient();

  const { data: job, error } = await supabase
    .from("jobs")
    .select("input_params, org_id")
    .eq("id", jobId)
    .single();

  if (error || !job) {
    throw new Error(
      `bulk-sms workflow: job ${jobId} not found: ${error?.message ?? "no row"}`,
    );
  }

  const params = job.input_params as {
    property_ids?: unknown;
    opts?: ResolvedBulkSmsQueueOpts;
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
  const rawOpts = params?.opts ?? null;
  const campaignId =
    rawOpts &&
    "campaignId" in rawOpts &&
    typeof rawOpts.campaignId === "string" &&
    rawOpts.campaignId.trim().length > 0
      ? rawOpts.campaignId.trim()
      : null;
  if (!rawOpts || !campaignId) {
    throw new Error(
      `bulk-sms workflow: job ${jobId} has no resolved campaign ID in input_params`,
    );
  }

  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .select("org_id, status")
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignError || !campaign) {
    throw new Error(
      `bulk-sms workflow: campaign ${campaignId} not found: ${campaignError?.message ?? "no row"}`,
    );
  }
  if (campaign.org_id !== job.org_id) {
    throw new Error(
      `bulk-sms workflow: campaign ${campaignId} does not match job org`,
    );
  }
  if (
    campaign.status !== "launching" &&
    campaign.status !== "completed" &&
    campaign.status !== "paused"
  ) {
    throw new Error(
      `bulk-sms workflow: campaign ${campaignId} is not launchable`,
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
    opts: {
      body: rawOpts.body,
      templateCategory: rawOpts.templateCategory,
      paceSeconds: rawOpts.paceSeconds,
      pacingProfile: rawOpts.pacingProfile,
      skipIfContacted: rawOpts.skipIfContacted,
      jitterPct: rawOpts.jitterPct,
      includeUnknown: rawOpts.includeUnknown,
      campaignId,
      campaignSource: rawOpts.campaignSource,
    },
    initialState: freshScheduleState(params?.anchor_ms ?? Date.now()),
  };
}

async function failBulkSmsLoadStep(args: {
  errorMessage: string;
  jobId: string;
}): Promise<void> {
  "use step";

  const supabase = createAdminClient();
  await supabase
    .from("jobs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: args.errorMessage,
      result_summary: {
        queued: 0,
        skipped: 0,
        failed: 0,
        workflow_error: args.errorMessage,
      },
    })
    .eq("id", args.jobId);
}

/**
 * STEP 2 — Queue one slice. Runs under the admin client (same privilege
 * level as the cron releaser that will transmit these messages); the
 * release path re-checks consent + quiet hours per message at send time.
 */
async function bulkSmsChunkStep(args: {
  jobId: string;
  propertyIds: string[];
  opts: ResolvedBulkSmsQueueOpts;
  processedBefore: number;
  state: BulkSmsScheduleState;
}): Promise<BulkSmsScheduleState> {
  "use step";

  const adminClient = createAdminClient();
  const { queueSmsBatch } = await import("@/lib/messaging/bulk-queue");
  const state = await queueSmsBatch(adminClient, {
    propertyIds: args.propertyIds,
    opts: args.opts,
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
  campaignId: string | null;
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

  if (args.campaignId) {
    await completeCampaign(args.campaignId);
  }

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

async function failBulkSmsJobStep(args: BulkSmsJobFailureArgs): Promise<void> {
  "use step";

  const supabase = createAdminClient();
  const { state } = args;
  const { count } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("campaign_id", args.campaignId)
    .eq("direction", "outbound");
  const stampedCount = count ?? state.succeeded;
  const terminalStatus = stampedCount > 0 ? "partial" : "failed";
  const processedItems = Math.min(
    args.total,
    state.succeeded + state.skipped + state.failed.length,
  );
  const failedItems = Math.max(
    state.failed.length,
    args.total - processedItems,
  );
  const now = new Date().toISOString();

  await supabase
    .from("jobs")
    .update({
      status: terminalStatus,
      processed_items: processedItems,
      succeeded_items: state.succeeded,
      failed_items: failedItems,
      completed_at: now,
      error_message: args.errorMessage,
      result_summary: {
        queued: state.succeeded,
        skipped: state.skipped,
        failed: failedItems,
        failed_sample: state.failed.slice(0, 20),
        workflow_error: args.errorMessage,
      },
    })
    .eq("id", args.jobId);

  if (stampedCount > 0) {
    await supabase
      .from("campaigns")
      .update({ status: "completed", updated_at: now })
      .eq("id", args.campaignId)
      .eq("status", "launching");
    return;
  }

  if (args.campaignSource === "ad_hoc_bulk_sms") {
    await supabase
      .from("campaigns")
      .update({
        status: "archived",
        archived_at: now,
        updated_at: now,
      })
      .eq("id", args.campaignId)
      .eq("status", "launching");
    return;
  }

  await supabase
    .from("campaigns")
    .update({ status: "active", updated_at: now })
    .eq("id", args.campaignId)
    .eq("status", "launching");
}

/** `start(bulkSmsWorkflow, [{ jobId }])` — load → chunk loop → finalize. */
export async function bulkSmsWorkflow(
  params: BulkSmsWorkflowParams,
): Promise<{ queued: number; skipped: number; failed: number }> {
  "use workflow";

  let loaded: LoadedBulkSmsJob;
  try {
    loaded = await loadBulkSmsJob(params.jobId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await failBulkSmsLoadStep({ errorMessage: message, jobId: params.jobId });
    throw e;
  }

  let state = loaded.initialState;

  try {
    for (
      let offset = 0;
      offset < loaded.propertyIds.length;
      offset += CHUNK_SIZE
    ) {
      state = await bulkSmsChunkStep({
        jobId: params.jobId,
        propertyIds: loaded.propertyIds.slice(offset, offset + CHUNK_SIZE),
        opts: loaded.opts,
        processedBefore: offset,
        state,
      });
    }

    await finalizeBulkSmsStep({
      campaignId: loaded.opts.campaignId ?? null,
      jobId: params.jobId,
      total: loaded.propertyIds.length,
      state,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await failBulkSmsJobStep({
      campaignId: loaded.opts.campaignId,
      campaignSource: loaded.opts.campaignSource,
      errorMessage: message,
      jobId: params.jobId,
      state,
      total: loaded.propertyIds.length,
    });
    throw e;
  }

  return {
    queued: state.succeeded,
    skipped: state.skipped,
    failed: state.failed.length,
  };
}
