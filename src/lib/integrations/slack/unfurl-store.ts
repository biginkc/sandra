import { randomUUID } from "node:crypto";

import { DatabaseError } from "@/lib/errors/classes";
import { createAdminClient } from "@/lib/supabase/admin";

import { getSlackInstallation, type SlackInstallation } from "./installation";

type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
};

type QueryClient = {
  from(table: string): QueryBuilder;
};

type QueryBuilder = {
  select(columns: string): QueryBuilder;
  eq(column: string, value: unknown): QueryBuilder;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
  order(column: string, options: { ascending: boolean }): Promise<{ data: unknown[] | null; error: { message: string } | null }>;
  update(values: Record<string, unknown>): QueryBuilder;
  then<TResult1 = QueryResponse, TResult2 = never>(onfulfilled?: ((value: QueryResponse) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2>;
};

type QueryResponse = { data: unknown[] | null; error: { message: string } | null };

export type SlackEventJobUrl = {
  url_key: string;
  lead_id: string | null;
  lookup_status: string | null;
  authorization_status: string | null;
  last_error_code: string | null;
};

export type SlackUnfurlJob = {
  id: string;
  receipt_id: string;
  installation_id: string | null;
  installation_version: number | null;
  policy_revision: number | null;
  org_id: string | null;
  team_id: string;
  app_id: string;
  channel_id: string;
  message_ts: string;
  poster_slack_user_id: string;
  event_time: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_expires_at: string | null;
  claim_token: string | null;
  last_error_code: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export type SlackPreviewPolicy = {
  installationId: string;
  orgId: string;
  mode: "legacy" | "eligible_internal_channels" | "disabled";
  policyRevision: number;
};

export type SlackPreviewPolicyMode = SlackPreviewPolicy["mode"];

export type SlackPreviewInstallation = {
  id: string;
  teamName: string | null;
  appId: string;
  status: "active" | "revoked";
  currentVersion: number;
  policyMode: SlackPreviewPolicyMode;
  policyEnabled: boolean;
  accountLinked: boolean;
};

export type SlackInstallationIdentity = {
  installationId: string;
  orgId: string;
  teamId: string;
  appId: string;
  installationVersion: number;
  status: "active" | "revoked";
  scopes: string[];
};

function admin(): QueryClient & RpcClient {
  return createAdminClient() as unknown as QueryClient & RpcClient;
}

function rpcError(error: { message: string; code?: string } | null, operation: string): never | void {
  if (!error) return;
  throw new DatabaseError(`Slack ${operation} failed`, { code: error.code, message: error.message });
}

export function isSlackUnfurlInstallationStaleError(error: unknown): boolean {
  if (!(error instanceof DatabaseError)) return false;
  const detail = error.details?.message;
  return /\bINSTALLATION_(?:NOT_ACTIVE|VERSION_MISMATCH)\b/.test(`${error.message} ${typeof detail === "string" ? detail : ""}`);
}

export async function findSlackInstallations(teamId: string, appId: string): Promise<SlackInstallationIdentity[]> {
  const { data, error } = await admin().from("slack_installations").select("id,org_id,team_id,app_id,installation_version,status,scopes").eq("team_id", teamId).eq("app_id", appId);
  if (error) throw new DatabaseError("Slack installation lookup failed", { message: error.message });
  return ((data ?? []) as Array<Record<string, unknown>>).flatMap((row) => {
    if (typeof row.id !== "string" || typeof row.org_id !== "string" || typeof row.team_id !== "string" || typeof row.app_id !== "string" || typeof row.installation_version !== "number") return [];
    const status = row.status === "active" ? "active" : row.status === "revoked" ? "revoked" : null;
    if (!status) return [];
    return [{ installationId: row.id, orgId: row.org_id, teamId: row.team_id, appId: row.app_id, installationVersion: row.installation_version, status, scopes: Array.isArray(row.scopes) ? row.scopes.filter((scope): scope is string => typeof scope === "string") : [] }];
  });
}

export async function loadSlackInstallation(input: { orgId: string; teamId: string; appId: string }): Promise<SlackInstallation | null> {
  return getSlackInstallation(input);
}

export async function loadSlackInstallationById(installationId: string): Promise<SlackInstallation | null> {
  const { data, error } = await admin().from("slack_installations").select("org_id,team_id,app_id").eq("id", installationId).maybeSingle();
  if (error) throw new DatabaseError("Slack installation lookup failed", { message: error.message });
  if (!data || typeof data.org_id !== "string" || typeof data.team_id !== "string" || typeof data.app_id !== "string") return null;
  return getSlackInstallation({ orgId: data.org_id, teamId: data.team_id, appId: data.app_id });
}

export async function loadSlackAccountLink(input: { installationId: string; orgId: string; slackUserId: string }): Promise<{ userId: string; status: "active" | "revoked" } | null> {
  const { data, error } = await admin().from("slack_account_links").select("user_id,status").eq("installation_id", input.installationId).eq("org_id", input.orgId).eq("slack_user_id", input.slackUserId).maybeSingle();
  if (error) throw new DatabaseError("Slack account link lookup failed", { message: error.message });
  if (!data || typeof data.user_id !== "string") return null;
  return { userId: data.user_id, status: data.status === "active" ? "active" : "revoked" };
}

export async function hasActiveSlackMembership(input: { userId: string; orgId: string }): Promise<boolean> {
  const { data, error } = await admin().from("memberships").select("user_id,org_id,access_status,access_expires_at,deletion_prepared_at").eq("user_id", input.userId).eq("org_id", input.orgId).maybeSingle();
  if (error) throw new DatabaseError("Slack membership lookup failed", { message: error.message });
  if (!data || data.user_id !== input.userId || data.org_id !== input.orgId) return false;
  if (data.access_status !== "active") return false;
  if (data.deletion_prepared_at) return false;
  return typeof data.access_expires_at !== "string" || Date.parse(data.access_expires_at) > Date.now();
}

export async function loadSlackChannelApproval(input: { installationId: string; orgId: string; channelId: string }): Promise<{ installationId: string; orgId: string; channelId: string; status: "active" | "revoked"; sharingPolicyAcknowledged: boolean } | null> {
  const { data, error } = await admin().from("slack_channel_approvals").select("installation_id,org_id,channel_id,status,sharing_policy_acknowledged").eq("installation_id", input.installationId).eq("org_id", input.orgId).eq("channel_id", input.channelId).maybeSingle();
  if (error) throw new DatabaseError("Slack channel approval lookup failed", { message: error.message });
  if (!data || typeof data.installation_id !== "string" || typeof data.org_id !== "string" || typeof data.channel_id !== "string") return null;
  return { installationId: data.installation_id, orgId: data.org_id, channelId: data.channel_id, status: data.status === "active" ? "active" : "revoked", sharingPolicyAcknowledged: data.sharing_policy_acknowledged === true };
}

export async function loadSlackPreviewPolicy(input: { installationId: string; orgId: string }): Promise<SlackPreviewPolicy> {
  const { data, error } = await admin().from("slack_preview_policies").select("installation_id,org_id,mode,policy_revision").eq("installation_id", input.installationId).eq("org_id", input.orgId).maybeSingle();
  if (error) throw new DatabaseError("Slack preview policy lookup failed", { message: error.message });
  const revision = parsePolicyRevision(data?.policy_revision);
  if (!data || typeof data.installation_id !== "string" || typeof data.org_id !== "string" || revision === null) {
    return { installationId: input.installationId, orgId: input.orgId, mode: "legacy", policyRevision: 0 };
  }
  const mode = data.mode === "eligible_internal_channels" || data.mode === "disabled" ? data.mode : "legacy";
  return { installationId: data.installation_id, orgId: data.org_id, mode, policyRevision: revision };
}

export async function loadSlackChannelDenial(input: { installationId: string; orgId: string; channelId: string }): Promise<boolean> {
  const { data, error } = await admin().from("slack_channel_denials").select("channel_id").eq("installation_id", input.installationId).eq("org_id", input.orgId).eq("channel_id", input.channelId).maybeSingle();
  if (error) throw new DatabaseError("Slack channel denial lookup failed", { message: error.message });
  return !!data && data.channel_id === input.channelId;
}

export async function setSlackPreviewPolicy(input: { installationId: string; orgId: string; ownerId: string; enabled: boolean }): Promise<{ mode: SlackPreviewPolicy["mode"]; policyRevision: number }> {
  const { data, error } = await admin().rpc("set_slack_preview_policy", {
    p_installation_id: input.installationId,
    p_org_id: input.orgId,
    p_owner_id: input.ownerId,
    p_enabled: input.enabled,
  });
  rpcError(error, "preview policy update");
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : (data as Record<string, unknown> | null);
  const revision = parsePolicyRevision(row?.policy_revision);
  if (!row || revision === null) throw new DatabaseError("Slack preview policy update returned no revision", {});
  const mode = row.mode === "eligible_internal_channels" || row.mode === "disabled" ? row.mode : "legacy";
  return { mode, policyRevision: revision };
}

function parsePolicyRevision(value: unknown): number | null {
  const revision = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

export async function listSlackPreviewInstallations(input: { orgId: string; userId: string }): Promise<SlackPreviewInstallation[]> {
  const { data, error } = await admin().rpc("list_slack_preview_installations", {
    p_org_id: input.orgId,
    p_user_id: input.userId,
  });
  rpcError(error, "preview installation listing");
  return (Array.isArray(data) ? data : []).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const candidate = row as Record<string, unknown>;
    if (typeof candidate.installation_id !== "string" || (candidate.team_name !== null && typeof candidate.team_name !== "string") || typeof candidate.app_id !== "string" || typeof candidate.installation_version !== "number") return [];
    const status = candidate.status === "active" ? "active" : candidate.status === "revoked" ? "revoked" : null;
    const policyMode = candidate.policy_mode === "legacy" || candidate.policy_mode === "eligible_internal_channels" || candidate.policy_mode === "disabled" ? candidate.policy_mode : null;
    if (!status || !policyMode) return [];
    return [{ id: candidate.installation_id, teamName: candidate.team_name, appId: candidate.app_id, status, currentVersion: candidate.installation_version, policyMode, policyEnabled: candidate.policy_enabled === true, accountLinked: candidate.account_linked === true }];
  });
}

export async function approveSlackChannel(input: { installationId: string; orgId: string; channelId: string; approvedBy: string; sharingPolicyAcknowledged: true }): Promise<string> {
  const { data, error } = await admin().rpc("approve_slack_channel", {
    p_installation_id: input.installationId,
    p_org_id: input.orgId,
    p_channel_id: input.channelId,
    p_approved_by: input.approvedBy,
    p_sharing_policy_acknowledged: input.sharingPolicyAcknowledged,
  });
  rpcError(error, "channel approval");
  if (typeof data !== "string") throw new DatabaseError("Slack channel approval returned no id", {});
  return data;
}

export async function enqueueSlackUnfurlEvent(input: {
  teamId: string;
  appId: string;
  eventId: string;
  eventType: string;
  eventTime: string | null;
  orgId: string | null;
  installationId: string | null;
  installationVersion: number | null;
  channelId: string | null;
  messageTs: string | null;
  posterSlackUserId: string | null;
  urlKeys: string[];
  denialCode?: string | null;
}): Promise<{ accepted: boolean; duplicate: boolean; jobId: string | null }> {
  const { data, error } = await admin().rpc("enqueue_slack_unfurl_event", {
    p_team_id: input.teamId,
    p_app_id: input.appId,
    p_event_id: input.eventId,
    p_event_type: input.eventType,
    p_event_time: input.eventTime,
    p_org_id: input.orgId,
    p_installation_id: input.installationId,
    p_installation_version: input.installationVersion,
    p_channel_id: input.channelId,
    p_message_ts: input.messageTs,
    p_poster_slack_user_id: input.posterSlackUserId,
    p_url_keys: input.urlKeys,
    p_denial_code: input.denialCode ?? null,
  });
  rpcError(error, "event enqueue");
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : (data as Record<string, unknown> | null);
  return { accepted: row?.accepted !== false, duplicate: row?.duplicate === true, jobId: typeof row?.job_id === "string" ? row.job_id : null };
}

export async function claimSlackUnfurlJobs(input: { now?: Date; limit?: number; leaseSeconds?: number } = {}): Promise<SlackUnfurlJob[]> {
  const claimToken = randomUUID();
  const { data, error } = await admin().rpc("claim_slack_unfurl_jobs", {
    p_now: (input.now ?? new Date()).toISOString(),
    p_claim_token: claimToken,
    p_lease_seconds: input.leaseSeconds ?? 90,
    p_limit: input.limit ?? 10,
  });
  rpcError(error, "job claim");
  const jobs = Array.isArray(data) ? (data as SlackUnfurlJob[]) : [];
  return jobs.map((job) => ({ ...job, claim_token: claimToken }));
}

export async function loadSlackJobUrls(jobId: string): Promise<SlackEventJobUrl[]> {
  const { data, error } = await admin().from("slack_unfurl_job_urls").select("url_key,lead_id,lookup_status,authorization_status,last_error_code").eq("job_id", jobId).order("url_key", { ascending: true });
  if (error) throw new DatabaseError("Slack job URL lookup failed", { message: error.message });
  return (data ?? []) as SlackEventJobUrl[];
}

export async function updateSlackJobUrl(input: { jobId: string; urlKey: string; leadId?: string | null; lookupStatus?: string | null; authorizationStatus?: string | null; errorCode?: string | null }): Promise<void> {
  const { error } = await admin().from("slack_unfurl_job_urls").update({ lead_id: input.leadId ?? null, lookup_status: input.lookupStatus ?? null, authorization_status: input.authorizationStatus ?? null, last_error_code: input.errorCode ?? null, updated_at: new Date().toISOString() }).eq("job_id", input.jobId).eq("url_key", input.urlKey);
  if (error) throw new DatabaseError("Slack job URL update failed", { message: error.message });
}

export async function finishSlackUnfurlJob(input: { jobId: string; claimToken: string; status: "succeeded" | "noop" | "expired" | "cancelled" | "failed"; errorCode?: string | null }): Promise<boolean> {
  const { data, error } = await admin().rpc("finish_slack_unfurl_job", { p_job_id: input.jobId, p_claim_token: input.claimToken, p_status: input.status, p_error_code: input.errorCode ?? null });
  rpcError(error, "job completion");
  return data === true || (Array.isArray(data) && data[0] === true);
}

export async function rescheduleSlackUnfurlJob(input: { jobId: string; claimToken: string; nextAttemptAt: Date; errorCode: string }): Promise<boolean> {
  const { data, error } = await admin().rpc("reschedule_slack_unfurl_job", { p_job_id: input.jobId, p_claim_token: input.claimToken, p_next_attempt_at: input.nextAttemptAt.toISOString(), p_error_code: input.errorCode });
  rpcError(error, "job reschedule");
  return data === true || (Array.isArray(data) && data[0] === true);
}

export async function guardSlackUnfurlDispatch(input: {
  jobId: string;
  claimToken: string;
  installationId: string;
  installationVersion: number;
  orgId: string;
  channelId: string;
  posterSlackUserId: string;
}): Promise<boolean> {
  const { data, error } = await admin().rpc("guard_slack_unfurl_dispatch", {
    p_job_id: input.jobId,
    p_claim_token: input.claimToken,
    p_installation_id: input.installationId,
    p_installation_version: input.installationVersion,
    p_org_id: input.orgId,
    p_channel_id: input.channelId,
    p_poster_slack_user_id: input.posterSlackUserId,
  });
  rpcError(error, "dispatch guard");
  return data === true || (Array.isArray(data) && data[0] === true);
}

export async function releaseSlackUnfurlJobClaim(input: { jobId: string; claimToken: string }): Promise<boolean> {
  const { data, error } = await admin().rpc("release_slack_unfurl_job_claim", {
    p_job_id: input.jobId,
    p_claim_token: input.claimToken,
  });
  rpcError(error, "job claim release");
  return data === true || (Array.isArray(data) && data[0] === true);
}

export async function revokeSlackInstallation(teamId: string, appId: string, reason: string): Promise<void> {
  const { error } = await admin().rpc("revoke_slack_installation", { p_team_id: teamId, p_app_id: appId, p_reason: reason });
  rpcError(error, "installation revocation");
}

/**
 * Revoke only the installation generation that produced a worker job.
 *
 * A Slack API response can arrive after an uninstall/reinstall. The worker
 * must not let that stale response revoke the newly installed generation.
 * The database function locks and compares the generation before changing
 * any installation-owned state, returning zero for a stale generation.
 */
export async function revokeSlackInstallationGeneration(input: {
  teamId: string;
  appId: string;
  installationId: string;
  installationVersion: number;
  reason: string;
}): Promise<number> {
  const { data, error } = await admin().rpc("revoke_slack_installation_generation", {
    p_team_id: input.teamId,
    p_app_id: input.appId,
    p_installation_id: input.installationId,
    p_installation_version: input.installationVersion,
    p_reason: input.reason,
  });
  rpcError(error, "installation generation revocation");
  if (typeof data === "number") return data;
  if (Array.isArray(data) && typeof data[0] === "number") return data[0];
  return 0;
}

export async function revokeSlackChannelApproval(teamId: string, appId: string, channelId: string, reason: string): Promise<void> {
  const { error } = await admin().rpc("revoke_slack_channel_approval", { p_team_id: teamId, p_app_id: appId, p_channel_id: channelId, p_reason: reason });
  rpcError(error, "channel approval revocation");
}

export async function revokeSlackAccountLinks(teamId: string, appId: string, slackUserIds: string[], reason: string): Promise<void> {
  const { error } = await admin().rpc("revoke_slack_account_links", { p_team_id: teamId, p_app_id: appId, p_slack_user_ids: slackUserIds, p_reason: reason });
  rpcError(error, "account revocation");
}

export async function processSlackLifecycleEvent(input: {
  teamId: string;
  appId: string;
  eventId: string;
  eventType: string;
  eventTime: string | null;
  channelId: string | null;
  slackUserIds: string[];
  action: "installation" | "account_links" | "channel" | "noop";
}): Promise<boolean> {
  const { data, error } = await admin().rpc("process_slack_lifecycle_event", {
    p_team_id: input.teamId,
    p_app_id: input.appId,
    p_event_id: input.eventId,
    p_event_type: input.eventType,
    p_event_time: input.eventTime,
    p_channel_id: input.channelId,
    p_slack_user_ids: input.slackUserIds,
    p_action: input.action,
  });
  rpcError(error, "lifecycle event");
  return data === true || (Array.isArray(data) && data[0] === true);
}

export async function cleanupSlackUnfurlData(cutoff: Date): Promise<number> {
  const { data, error } = await admin().rpc("cleanup_slack_unfurl_data", { p_cutoff: cutoff.toISOString() });
  rpcError(error, "retention cleanup");
  return typeof data === "number" ? data : Array.isArray(data) && typeof data[0] === "number" ? data[0] : 0;
}
