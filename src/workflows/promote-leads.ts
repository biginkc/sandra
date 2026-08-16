/** Durable Prospects -> Leads promotion workflow. */

import { runPromoteLeadsChunk } from "@/lib/leads/promote-job";
import { createAdminClient } from "@/lib/supabase/admin";

export type PromoteLeadsWorkflowParams = {
  jobId: string;
};

const CHUNK_SIZE = 100;

type PromotionClaim =
  | {
      status: "claimed";
      jobId: string;
      orgId: string;
      createdBy: string;
    }
  | { status: "not_runnable"; jobId: string; jobStatus: string };

async function createPromotionClaimToken(): Promise<string> {
  "use step";
  return crypto.randomUUID();
}

async function claimPromotionJob(jobId: string, claimToken: string): Promise<PromotionClaim> {
  "use step";

  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("jobs")
    .update({
      status: "running",
      started_at: now,
      worker_heartbeat_at: now,
      workflow_claim_token: claimToken,
      error_class: null,
      error_message: null,
    })
    .eq("id", jobId)
    .eq("type", "promote_leads")
    .eq("status", "queued")
    .is("workflow_claim_token", null)
    .select("id, org_id, created_by, status, workflow_claim_token")
    .maybeSingle();
  if (claimError) throw new Error(`Promotion workflow could not claim job: ${claimError.message}`);

  const { data: current, error: currentError } = claimed
    ? { data: claimed, error: null }
    : await supabase
        .from("jobs")
        .select("id, org_id, created_by, status, workflow_claim_token")
        .eq("id", jobId)
        .eq("type", "promote_leads")
        .maybeSingle();
  if (currentError) throw new Error(`Promotion workflow could not load job: ${currentError.message}`);
  const job = current;
  if (!job) throw new Error(`Promotion workflow job ${jobId} was not found`);
  if (job.status !== "running" || job.workflow_claim_token !== claimToken) {
    return { status: "not_runnable", jobId, jobStatus: job.status };
  }
  if (!job.created_by) {
    throw new Error(`Promotion workflow job ${jobId} has no requesting actor`);
  }

  return {
    status: "claimed",
    jobId: job.id,
    orgId: job.org_id,
    createdBy: job.created_by,
  };
}

async function checkpointPromotionWorkflowFailure(args: {
  jobId: string;
  claimToken: string;
  error: string;
}): Promise<unknown> {
  "use step";
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("fail_promote_leads_workflow", {
    p_job: args.jobId,
    p_claim_token: args.claimToken,
    p_error: args.error,
  });
  if (error) {
    throw new Error(`Promotion workflow failure checkpoint failed: ${error.message}`);
  }
  return data;
}

async function loadPendingPromotionChunk(jobId: string): Promise<string[]> {
  "use step";
  const supabase = createAdminClient();
  const { data: items, error: itemError } = await supabase
    .from("job_items")
    .select("item_key")
    .eq("job_id", jobId)
    .eq("status", "pending")
    .order("item_key", { ascending: true })
    .limit(CHUNK_SIZE);
  if (itemError) throw new Error(`Promotion workflow could not load items: ${itemError.message}`);

  return (items ?? [])
    .map((item) => item.item_key)
    .filter((key): key is string => typeof key === "string" && key.length > 0);
}

async function processPromotionChunk(args: {
  jobId: string;
  itemKeys: string[];
}): Promise<void> {
  "use step";
  const supabase = createAdminClient();
  await runPromoteLeadsChunk(supabase, args);
}

async function finalizePromotionJob(jobId: string): Promise<unknown> {
  "use step";
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("promote_leads_recompute_job", {
    p_job: jobId,
  });
  if (error) throw new Error(`Promotion workflow final checkpoint failed: ${error.message}`);
  return data;
}

export async function promoteLeadsWorkflow(
  params: PromoteLeadsWorkflowParams,
): Promise<unknown> {
  "use workflow";

  const claimToken = await createPromotionClaimToken();
  try {
    const claim = await claimPromotionJob(params.jobId, claimToken);
    if (claim.status !== "claimed") return claim;

    while (true) {
      const itemKeys = await loadPendingPromotionChunk(claim.jobId);
      if (itemKeys.length === 0) break;
      await processPromotionChunk({
        jobId: claim.jobId,
        itemKeys,
      });
    }

    return await finalizePromotionJob(claim.jobId);
  } catch (error) {
    return checkpointPromotionWorkflowFailure({
      jobId: params.jobId,
      claimToken,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

Object.assign(createPromotionClaimToken, { maxRetries: 0 });
Object.assign(claimPromotionJob, { maxRetries: 2 });
Object.assign(loadPendingPromotionChunk, { maxRetries: 2 });
Object.assign(processPromotionChunk, { maxRetries: 2 });
Object.assign(finalizePromotionJob, { maxRetries: 2 });
Object.assign(checkpointPromotionWorkflowFailure, { maxRetries: 5 });
