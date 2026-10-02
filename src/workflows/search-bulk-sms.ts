/**
 * Search page deferred bulk SMS (more than 500 prospects). A Search-OWNED workflow: the legacy
 * `bulk-sms` workflow is untouched and never re-checks recipient status, so a recipient promoted
 * to a lead between the freeze and its chunk could still be texted. This workflow re-validates
 * EVERY chunk against current state (same Search partition: live, non-DNC prospects only) before
 * calling the queue worker, and records the skipped leads per chunk and in total.
 *
 *   1. loadSearchSmsJob     - read the frozen prospect ids + resolved opts, validate provenance
 *   2. searchSmsChunkStep   - partition the slice to CURRENT prospects, then queueSmsBatch
 *   3. finalize / fail      - terminal status + result_summary (incl. skipped_leads)
 *
 * Node built-ins are banned in the workflow bundle, so the queue library is imported
 * dynamically inside steps (see bulk-sms.ts).
 */

import type {
  BulkSmsScheduleState,
  ResolvedBulkSmsQueueOpts,
} from "@/lib/messaging/bulk-queue";
import { AD_HOC_BULK_SMS_SOURCE as AD_HOC_SOURCE } from "@/lib/messaging/ad-hoc-sms-source";
import { partitionSearchIds } from "@/lib/prospects/search-partition";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  refreshCampaignScheduleForChunk,
  repairCampaignQueueCadenceAfterChunk,
} from "@/workflows/bulk-sms";

const CHUNK_SIZE = 200;
/** Marks a job as Search-owned so only this workflow runs it. */
export const SEARCH_SMS_JOB_SURFACE = "search";

export type SearchBulkSmsWorkflowParams = { jobId: string };

type Loaded = {
  propertyIds: string[];
  opts: ResolvedBulkSmsQueueOpts;
  initialState: BulkSmsScheduleState;
  campaignId: string;
};

async function loadSearchSmsJob(jobId: string): Promise<Loaded> {
  "use step";

  const supabase = createAdminClient();
  const { data: job, error } = await supabase
    .from("jobs")
    .select("input_params, org_id, type")
    .eq("id", jobId)
    .single();
  if (error || !job) throw new Error(`search-bulk-sms: job ${jobId} not found: ${error?.message ?? "no row"}`);
  const params = job.input_params as {
    surface?: string;
    property_ids?: unknown;
    opts?: ResolvedBulkSmsQueueOpts;
    anchor_ms?: number;
  } | null;
  if (job.type !== "bulk_sms" || params?.surface !== SEARCH_SMS_JOB_SURFACE) {
    throw new Error(`search-bulk-sms: job ${jobId} is not a Search bulk SMS job`);
  }
  const propertyIds = Array.isArray(params.property_ids)
    ? params.property_ids.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  if (propertyIds.length === 0) throw new Error(`search-bulk-sms: job ${jobId} has no property ids`);
  const rawOpts = params.opts;
  const campaignId =
    rawOpts && typeof rawOpts.campaignId === "string" && rawOpts.campaignId.trim() ? rawOpts.campaignId.trim() : null;
  if (!rawOpts || !campaignId) throw new Error(`search-bulk-sms: job ${jobId} has no campaign`);

  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .select("org_id, status, audience_snapshot")
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignError || !campaign) throw new Error(`search-bulk-sms: campaign ${campaignId} not found`);
  if (campaign.org_id !== job.org_id) throw new Error("search-bulk-sms: campaign does not match job org");
  // Same statuses as the legacy workflow accepts, so a step retry or replay of a job that already
  // started (campaign completed/paused by an earlier attempt) is not rejected.
  if (!["launching", "completed", "paused"].includes(campaign.status ?? "")) {
    throw new Error("search-bulk-sms: campaign is not launchable");
  }
  // Provenance comes from the stored campaign row, never from job input.
  const source = (campaign.audience_snapshot as { source?: unknown } | null)?.source;
  if (source !== AD_HOC_SOURCE) throw new Error("search-bulk-sms: campaign is not an ad-hoc bulk SMS campaign");

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
    campaignId,
    opts: {
      body: rawOpts.body,
      templateCategory: rawOpts.templateCategory,
      paceSeconds: rawOpts.paceSeconds,
      pacingProfile: rawOpts.pacingProfile,
      skipIfContacted: rawOpts.skipIfContacted,
      jitterPct: rawOpts.jitterPct,
      includeUnknown: rawOpts.includeUnknown,
      campaignId,
      campaignSource: "ad_hoc_bulk_sms",
    },
    initialState: freshScheduleState(params.anchor_ms ?? Date.now()),
  };
}

/**
 * Queue one slice of the frozen audience, but only the rows that are STILL live, non-DNC
 * prospects at this moment. Anything promoted (or locked, deleted) since the freeze is
 * skipped and counted; it is never texted.
 */
export async function searchSmsChunkStep(args: {
  jobId: string;
  propertyIds: string[];
  opts: ResolvedBulkSmsQueueOpts;
  processedBefore: number;
  state: BulkSmsScheduleState;
}): Promise<{ state: BulkSmsScheduleState; skippedLeads: number; skippedDnc: number }> {
  "use step";

  const adminClient = createAdminClient();
  const { queueSmsBatch } = await import("@/lib/messaging/bulk-queue");
  const part = await partitionSearchIds(adminClient, args.propertyIds);
  const chunkIds = part.prospectIds;
  const refreshed = await refreshCampaignScheduleForChunk(adminClient, args.jobId, chunkIds, args.opts, args.state);
  const state =
    chunkIds.length === 0
      ? refreshed.state
      : await queueSmsBatch(adminClient, { propertyIds: chunkIds, opts: refreshed.opts, state: refreshed.state });
  await repairCampaignQueueCadenceAfterChunk(adminClient, args.jobId, refreshed.opts);
  await adminClient
    .from("jobs")
    .update({
      // processed_items counts every frozen row the workflow has gone through, INCLUDING the ones
      // skipped because they are no longer prospects (they are reported in skipped_leads/_dnc).
      processed_items: args.processedBefore + args.propertyIds.length,
      succeeded_items: state.succeeded,
      failed_items: state.failed.length,
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", args.jobId);
  return { state, skippedLeads: part.skippedLeads, skippedDnc: part.dncLockedIds.length };
}

/**
 * The load step failed (bad provenance, missing campaign, ...). The Search action already created
 * the ad-hoc campaign in `launching`; do not leave it stranded: fail the job and archive that
 * campaign, but ONLY if the job is a Search-owned job and the campaign is an ad-hoc bulk-SMS
 * campaign of the same org that is still `launching` and has queued nothing.
 */
async function failSearchSmsLoadStep(args: { jobId: string; errorMessage: string }): Promise<void> {
  "use step";

  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { data: job } = await supabase.from("jobs").select("org_id, type, input_params").eq("id", args.jobId).maybeSingle();
  await supabase
    .from("jobs")
    .update({
      status: "failed",
      completed_at: now,
      error_message: args.errorMessage,
      result_summary: { queued: 0, skipped: 0, failed: 0, workflow_error: args.errorMessage },
    })
    .eq("id", args.jobId);
  const params = job?.input_params as { surface?: string; opts?: { campaignId?: string } } | null;
  const campaignId = params?.opts?.campaignId;
  if (!job || job.type !== "bulk_sms" || params?.surface !== SEARCH_SMS_JOB_SURFACE || !campaignId) return;
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("org_id, status, audience_snapshot")
    .eq("id", campaignId)
    .maybeSingle();
  const source = (campaign?.audience_snapshot as { source?: unknown } | null)?.source;
  if (!campaign || campaign.org_id !== job.org_id || campaign.status !== "launching" || source !== AD_HOC_SOURCE) return;
  const { count } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("direction", "outbound");
  if ((count ?? 0) > 0) return;
  await supabase
    .from("campaigns")
    .update({ status: "archived", archived_at: now, updated_at: now })
    .eq("id", campaignId)
    .eq("status", "launching");
}

async function finalizeSearchSmsStep(args: {
  campaignId: string;
  jobId: string;
  total: number;
  state: BulkSmsScheduleState;
  skippedLeads: number;
  skippedDnc: number;
}): Promise<void> {
  "use step";

  const supabase = createAdminClient();
  const { state } = args;
  const status = state.failed.length === 0 ? "completed" : state.succeeded > 0 ? "partial" : "failed";
  const now = new Date().toISOString();
  await supabase
    .from("campaigns")
    .update({ status: "completed", updated_at: now })
    .eq("id", args.campaignId)
    .in("status", ["launching", "completed"]);
  await supabase
    .from("jobs")
    .update({
      status,
      processed_items: args.total,
      succeeded_items: state.succeeded,
      failed_items: state.failed.length,
      completed_at: now,
      result_summary: {
        queued: state.succeeded,
        skipped: state.skipped,
        skipped_leads: args.skippedLeads,
        skipped_dnc: args.skippedDnc,
        failed: state.failed.length,
        failed_sample: state.failed.slice(0, 20),
      },
    })
    .eq("id", args.jobId);
}

async function failSearchSmsStep(args: {
  campaignId: string | null;
  errorMessage: string;
  jobId: string;
  state: BulkSmsScheduleState;
  total: number;
  skippedLeads: number;
}): Promise<void> {
  "use step";

  const supabase = createAdminClient();
  const { state } = args;
  let stamped = state.succeeded;
  if (args.campaignId) {
    const { count } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", args.campaignId)
      .eq("direction", "outbound");
    stamped = count ?? state.succeeded;
  }
  const now = new Date().toISOString();
  const failedItems = Math.max(state.failed.length, args.total - Math.min(args.total, state.succeeded + state.skipped + state.failed.length));
  await supabase
    .from("jobs")
    .update({
      status: stamped > 0 ? "partial" : "failed",
      succeeded_items: state.succeeded,
      failed_items: failedItems,
      completed_at: now,
      error_message: args.errorMessage,
      result_summary: {
        queued: state.succeeded,
        skipped: state.skipped,
        skipped_leads: args.skippedLeads,
        failed: failedItems,
        workflow_error: args.errorMessage,
      },
    })
    .eq("id", args.jobId);
  if (!args.campaignId) return;
  // Some messages queued: the campaign did send. None: archive the ad-hoc campaign.
  if (stamped > 0) {
    await supabase.from("campaigns").update({ status: "completed", updated_at: now }).eq("id", args.campaignId).eq("status", "launching");
  } else {
    await supabase.from("campaigns").update({ status: "archived", archived_at: now, updated_at: now }).eq("id", args.campaignId).eq("status", "launching");
  }
}

/** `start(searchBulkSmsWorkflow, [{ jobId }])`: load -> per-chunk re-validated queueing -> finalize. */
export async function searchBulkSmsWorkflow(
  params: SearchBulkSmsWorkflowParams,
): Promise<{ queued: number; skipped: number; skippedLeads: number; failed: number }> {
  "use workflow";

  let loaded: Loaded;
  try {
    loaded = await loadSearchSmsJob(params.jobId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await failSearchSmsLoadStep({ jobId: params.jobId, errorMessage: message });
    throw e;
  }
  let state = loaded.initialState;
  let skippedLeads = 0;
  let skippedDnc = 0;
  try {
    for (let offset = 0; offset < loaded.propertyIds.length; offset += CHUNK_SIZE) {
      const out = await searchSmsChunkStep({
        jobId: params.jobId,
        propertyIds: loaded.propertyIds.slice(offset, offset + CHUNK_SIZE),
        opts: loaded.opts,
        processedBefore: offset,
        state,
      });
      state = out.state;
      skippedLeads += out.skippedLeads;
      skippedDnc += out.skippedDnc;
    }
    await finalizeSearchSmsStep({
      campaignId: loaded.campaignId,
      jobId: params.jobId,
      total: loaded.propertyIds.length,
      state,
      skippedLeads,
      skippedDnc,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await failSearchSmsStep({
      campaignId: loaded.campaignId,
      errorMessage: message,
      jobId: params.jobId,
      state,
      total: loaded.propertyIds.length,
      skippedLeads,
    });
    throw e;
  }
  return { queued: state.succeeded, skipped: state.skipped, skippedLeads, failed: state.failed.length };
}
