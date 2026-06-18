/**
 * Skip-trace initial submission workflow.
 *
 * The request/approval actions create the job row; this workflow owns the
 * first provider submit. Keeping the submit inside a durable step prevents
 * Vercel function recycling from stranding jobs before provider_run_id is
 * written.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export type SkipTraceSubmitWorkflowParams = {
  jobId: string;
};

type SubmitOutcome =
  | { status: "submitted"; jobId: string }
  | { status: "already_submitted"; jobId: string; providerRunId: string }
  | { status: "not_runnable"; jobId: string; jobStatus: string }
  | { status: "claim_lost"; jobId: string };

async function submitSkipTraceJob(jobId: string): Promise<SubmitOutcome> {
  "use step";

  const supabase = createAdminClient();
  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, status, input_params, provider_run_id, worker_heartbeat_at")
    .eq("id", jobId)
    .eq("type", "skip_trace")
    .maybeSingle();

  if (error) {
    throw new Error(`skip-trace workflow: failed to load job ${jobId}: ${error.message}`);
  }
  if (!job) {
    throw new Error(`skip-trace workflow: job ${jobId} not found`);
  }
  if (job.provider_run_id) {
    return {
      status: "already_submitted",
      jobId,
      providerRunId: job.provider_run_id,
    };
  }
  if (job.status !== "queued" && job.status !== "running") {
    return { status: "not_runnable", jobId, jobStatus: job.status };
  }

  const propertyIds = (
    job.input_params as { property_ids?: unknown } | null
  )?.property_ids;
  const runnableIds = Array.isArray(propertyIds)
    ? propertyIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];

  if (runnableIds.length === 0) {
    await supabase
      .from("jobs")
      .update({
        status: "failed",
        error_class: "validation",
        error_message: "Skip-trace job has no property ids.",
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .is("provider_run_id", null);
    return { status: "not_runnable", jobId, jobStatus: "failed" };
  }

  const now = new Date().toISOString();
  let claim = supabase
    .from("jobs")
    .update({
      status: "running",
      started_at: now,
      total_items: runnableIds.length,
      worker_heartbeat_at: now,
    })
    .eq("id", jobId)
    .eq("status", job.status)
    .is("provider_run_id", null);

  claim = job.worker_heartbeat_at
    ? claim.eq("worker_heartbeat_at", job.worker_heartbeat_at)
    : claim.is("worker_heartbeat_at", null);

  const { data: claimed, error: claimErr } = await claim.select("id");
  if (claimErr) {
    throw new Error(`skip-trace workflow: failed to claim job ${jobId}: ${claimErr.message}`);
  }
  if (!claimed || claimed.length === 0) {
    return { status: "claim_lost", jobId };
  }

  const { runSkipTraceEnrichment } = await import(
    "@/lib/skip-trace/skip-trace-job"
  );
  await runSkipTraceEnrichment(supabase, {
    jobId,
    propertyIds: runnableIds,
  });

  return { status: "submitted", jobId };
}

export async function skipTraceSubmitWorkflow(
  params: SkipTraceSubmitWorkflowParams,
): Promise<SubmitOutcome> {
  "use workflow";

  return submitSkipTraceJob(params.jobId);
}
