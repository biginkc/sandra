/**
 * Skip-trace initial submission workflow.
 *
 * The request/approval actions create the job row; this workflow owns the
 * first provider submit. Keeping the submit inside a durable step prevents
 * Vercel function recycling from stranding jobs before provider_run_id is
 * written.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import {
  buildSkipTraceEligibilityAudit,
  mergeSkipTraceEligibilityAudits,
  resolveSkipTraceEligibility,
  skipTraceAudienceDescription,
  skipTraceAudienceTitle,
} from "@/lib/skip-trace/eligibility";

export type SkipTraceSubmitWorkflowParams = {
  jobId: string;
  orgId: string;
};

const SUBMIT_STALE_MS = 2 * 60 * 1000;

type SubmitOutcome =
  | { status: "submitted"; jobId: string }
  | { status: "already_submitted"; jobId: string; providerRunId: string }
  | { status: "not_runnable"; jobId: string; jobStatus: string }
  | { status: "canceled"; jobId: string; excluded: number }
  | { status: "claim_lost"; jobId: string };

function isStaleHeartbeat(heartbeat: string | null): boolean {
  if (!heartbeat) return true;
  const parsed = Date.parse(heartbeat);
  return Number.isNaN(parsed) || parsed < Date.now() - SUBMIT_STALE_MS;
}

function resultSummaryObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function submitSkipTraceJob(
  jobId: string,
  orgId: string,
): Promise<SubmitOutcome> {
  "use step";

  const supabase = createAdminClient();
  const { data: job, error } = await supabase
    .from("jobs")
    .select(
      "id, org_id, status, title, description, input_params, provider_run_id, worker_heartbeat_at, result_summary",
    )
    .eq("id", jobId)
    .eq("org_id", orgId)
    .eq("type", "skip_trace")
    .maybeSingle();

  if (error) {
    throw new Error(
      `skip-trace workflow: failed to load job ${jobId}: ${error.message}`,
    );
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
  if (job.status === "running") {
    if (!isStaleHeartbeat(job.worker_heartbeat_at)) {
      return { status: "claim_lost", jobId };
    }
    const summary = resultSummaryObject(job.result_summary);
    if (summary.submit_phase === "submitting") {
      return { status: "not_runnable", jobId, jobStatus: job.status };
    }
  }

  const propertyIds = (job.input_params as { property_ids?: unknown } | null)
    ?.property_ids;
  const runnableIds = Array.isArray(propertyIds)
    ? [
        ...new Set(
          propertyIds.filter(
            (x): x is string => typeof x === "string" && x.length > 0,
          ),
        ),
      ]
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
      .eq("org_id", job.org_id)
      .is("provider_run_id", null);
    return { status: "not_runnable", jobId, jobStatus: "failed" };
  }

  // Re-read every compliance input with the service-role client immediately
  // before the CAS claim. A request can wait for approval or retry long after
  // a homeowner opts out, so the stored property list is never authoritative.
  const eligibility = await resolveSkipTraceEligibility(supabase, {
    orgId: job.org_id,
    propertyIds: runnableIds,
  });
  const inputParams =
    job.input_params &&
    typeof job.input_params === "object" &&
    !Array.isArray(job.input_params)
      ? (job.input_params as Record<string, Json | undefined>)
      : {};
  const eligibilityAudit = mergeSkipTraceEligibilityAudits(
    inputParams.eligibility_exclusions,
    buildSkipTraceEligibilityAudit(eligibility, runnableIds.length),
  );
  const nextInputParams = {
    ...inputParams,
    property_ids: eligibility.eligibleIds,
    eligibility_exclusions: eligibilityAudit,
  } as unknown as Json;
  const priorSummary = resultSummaryObject(job.result_summary);

  if (eligibility.eligibleIds.length === 0) {
    const completedAt = new Date().toISOString();
    let cancel = supabase
      .from("jobs")
      .update({
        status: "canceled",
        total_items: 0,
        title: skipTraceAudienceTitle(job.title, 0, eligibilityAudit.total),
        description: skipTraceAudienceDescription(
          job.description,
          0,
          eligibilityAudit.total,
        ),
        input_params: nextInputParams,
        result_summary: {
          ...priorSummary,
          eligibility_exclusions: eligibilityAudit,
          submit_phase: "canceled_before_provider",
        } as unknown as Json,
        completed_at: completedAt,
        worker_heartbeat_at: completedAt,
        error_message: null,
      })
      .eq("id", jobId)
      .eq("org_id", job.org_id)
      .eq("status", job.status)
      .is("provider_run_id", null);
    cancel = job.worker_heartbeat_at
      ? cancel.eq("worker_heartbeat_at", job.worker_heartbeat_at)
      : cancel.is("worker_heartbeat_at", null);
    const { data: canceled, error: cancelError } = await cancel.select("id");
    if (cancelError) {
      throw new Error(
        `skip-trace workflow: failed to cancel ineligible job ${jobId}: ${cancelError.message}`,
      );
    }
    if (!canceled || canceled.length === 0) {
      return { status: "claim_lost", jobId };
    }
    return {
      status: "canceled",
      jobId,
      excluded: eligibilityAudit.total,
    };
  }

  const now = new Date().toISOString();
  let claim = supabase
    .from("jobs")
    .update({
      status: "queued",
      total_items: eligibility.eligibleIds.length,
      title: skipTraceAudienceTitle(
        job.title,
        eligibility.eligibleIds.length,
        eligibilityAudit.total,
      ),
      description: skipTraceAudienceDescription(
        job.description,
        eligibility.eligibleIds.length,
        eligibilityAudit.total,
      ),
      input_params: nextInputParams,
      worker_heartbeat_at: now,
      result_summary: {
        ...priorSummary,
        eligibility_exclusions: eligibilityAudit,
        submit_phase: "prepared",
        submit_phase_prepared_at: now,
      } as unknown as Json,
    })
    .eq("id", jobId)
    .eq("org_id", job.org_id)
    .eq("status", job.status)
    .is("provider_run_id", null);

  claim = job.worker_heartbeat_at
    ? claim.eq("worker_heartbeat_at", job.worker_heartbeat_at)
    : claim.is("worker_heartbeat_at", null);

  const { data: claimed, error: claimErr } = await claim.select("id");
  if (claimErr) {
    throw new Error(
      `skip-trace workflow: failed to claim job ${jobId}: ${claimErr.message}`,
    );
  }
  if (!claimed || claimed.length === 0) {
    return { status: "claim_lost", jobId };
  }

  const { runSkipTraceEnrichment } =
    await import("@/lib/skip-trace/skip-trace-job");
  const runnerOutcome = await runSkipTraceEnrichment(supabase, {
    jobId,
    orgId: job.org_id,
    propertyIds: eligibility.eligibleIds,
    inputParams: nextInputParams,
    eligibilityExclusions: eligibilityAudit as unknown as Json,
    expectedHeartbeat: now,
  });
  if ("claimed" in runnerOutcome && runnerOutcome.claimed === false) {
    return { status: "claim_lost", jobId };
  }

  return { status: "submitted", jobId };
}

export async function skipTraceSubmitWorkflow(
  params: SkipTraceSubmitWorkflowParams,
): Promise<SubmitOutcome> {
  "use workflow";

  return submitSkipTraceJob(params.jobId, params.orgId);
}

Object.assign(submitSkipTraceJob, { maxRetries: 0 });
