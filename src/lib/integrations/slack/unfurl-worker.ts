import { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";

import { createAdminClient } from "@/lib/supabase/admin";

import { buildPreviewBlocks } from "./unfurl-blocks";
import { verifySlackCanaryFixture, type SlackCanaryPreviewSnapshot } from "./unfurl-canary";
import { loadPreviewData } from "./unfurl-data";
import { hasSlackPreviewScopes } from "./installation";
import { verifySlackDestination, parseSlackLeadUrl } from "./unfurl-policy";
import {
  claimSlackUnfurlJobs,
  cleanupSlackUnfurlData,
  guardSlackUnfurlDispatch,
  finishSlackUnfurlJob,
  hasActiveSlackMembership,
  loadSlackAccountLink,
  loadSlackChannelDenial,
  loadSlackChannelApproval,
  loadSlackInstallation,
  loadSlackJobUrls,
  loadSlackPreviewPolicy,
  releaseSlackUnfurlJobClaim,
  revokeSlackInstallationGeneration,
  rescheduleSlackUnfurlJob,
  updateSlackJobUrl,
  type SlackUnfurlJob,
} from "./unfurl-store";

const WORK_BUDGET_MS = 45_000;
const LEASE_RESERVE_MS = 5_000;
const RETRY_DELAYS_SECONDS = [15, 30, 60, 120] as const;
const JOB_TTL_MS = 15 * 60_000;

type PreviewLoaderClient = ReturnType<typeof createAdminClient>;

type UnfurlPayload = {
  blocks: KnownBlock[];
  text: string;
};

export type SlackCanaryExecutionFence = {
  canonicalURL: string;
  propertyId: string;
  runId: string;
  snapshot: SlackCanaryPreviewSnapshot;
};

export type SlackSweepSummary = {
  claimed: number;
  succeeded: number;
  noops: number;
  expired: number;
  retried: number;
  failed: number;
  cleaned: number;
};

function isTerminalSlackIdentityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = slackApiErrorCode(error);
  return /invalid_auth|token_revoked|token_expired|account_inactive/i.test(message) || code === "invalid_auth" || code === "token_revoked" || code === "token_expired" || code === "account_inactive";
}

const TERMINAL_SLACK_UNFURL_ERRORS = new Set([
  "access_denied",
  "cannot_find_channel",
  "cannot_find_message",
  "cannot_unfurl_message",
  "cannot_unfurl_url",
  "missing_scope",
  "no_permission",
  "not_allowed_token_type",
  "team_access_not_granted",
]);

function slackApiErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { data?: { error?: unknown } };
  return typeof candidate.data?.error === "string" ? candidate.data.error : null;
}

function retryAfterSeconds(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; data?: { retry_after?: unknown; response_metadata?: { retryAfter?: unknown } }; retryAfter?: unknown };
  const value = candidate.code === "slack_webapi_rate_limited_error"
    ? candidate.retryAfter
    : candidate.data?.retry_after ?? candidate.data?.response_metadata?.retryAfter;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nextRetryAt(job: SlackUnfurlJob, now: number, retryAfter: number | null): Date {
  const backoff = RETRY_DELAYS_SECONDS[Math.min(Math.max(job.attempts - 1, 0), RETRY_DELAYS_SECONDS.length - 1)] ?? 120;
  return new Date(now + Math.max(backoff, retryAfter ?? 0) * 1000);
}

function jobExpiry(job: SlackUnfurlJob): number {
  return Math.min(Date.parse(job.expires_at), Date.parse(job.event_time) + JOB_TTL_MS);
}

function ensureWorkWindow(job: SlackUnfurlJob, deadline: number, reserveApi = false): void {
  const now = Date.now();
  const expiry = jobExpiry(job);
  const leaseExpiry = job.lease_expires_at ? Date.parse(job.lease_expires_at) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(expiry) || now >= expiry || now >= leaseExpiry) throw new Error("slack_unfurl_expired");
  if (now >= deadline) throw new Error("slack_unfurl_budget_exhausted");
  if (reserveApi) {
    if (now + 5_000 >= Math.min(expiry, leaseExpiry)) throw new Error("slack_unfurl_expired");
    if (now + 5_000 >= deadline) throw new Error("slack_unfurl_budget_exhausted");
  }
}

function isWindowError(error: unknown): boolean {
  return error instanceof Error && (error.message === "slack_unfurl_expired" || error.message === "slack_unfurl_budget_exhausted");
}

function identityErrorReason(error: unknown): string {
  return slackApiErrorCode(error) ?? "slack_identity_error";
}

function payloadForSnapshot(snapshot: unknown): UnfurlPayload {
  const rendered = buildPreviewBlocks(snapshot as Parameters<typeof buildPreviewBlocks>[0]);
  if (Array.isArray(rendered)) return { blocks: rendered as KnownBlock[], text: "Lead preview" };
  return rendered as UnfurlPayload;
}

function equalCanaryPreview(left: SlackCanaryPreviewSnapshot, right: SlackCanaryPreviewSnapshot): boolean {
  // Every field in SlackLeadPreviewSnapshot is a render fact. Keep this
  // comparison exhaustive so a future snapshot field cannot silently become
  // an unfenced provider input; there are no volatile fields to exclude.
  if (
    left.propertyId !== right.propertyId ||
    left.leadName !== right.leadName ||
    left.address !== right.address ||
    left.ownerName !== right.ownerName ||
    left.ownerAssigned !== right.ownerAssigned ||
    left.messagesDisposition !== right.messagesDisposition ||
    left.lastContactAt !== right.lastContactAt ||
    left.timezone !== right.timezone ||
    left.latestAttempt?.id !== right.latestAttempt?.id ||
    left.latestAttempt?.occurredAt !== right.latestAttempt?.occurredAt ||
    left.latestAttempt?.outcome !== right.latestAttempt?.outcome ||
    left.messages.length !== right.messages.length
  ) return false;
  return left.messages.every((message, index) => {
    const other = right.messages[index];
    return message.id === other?.id &&
      message.createdAt === other.createdAt &&
      message.body === other.body &&
      message.direction === other.direction &&
      message.deliveryStatus === other.deliveryStatus &&
      message.attachmentCount === other.attachmentCount;
  });
}

function isCanaryFenceError(error: unknown): boolean {
  return error instanceof Error && error.message === "slack_canary_fence_failed";
}

async function failCanaryFence(job: SlackUnfurlJob): Promise<never> {
  if (job.claim_token) {
    await finishSlackUnfurlJob({ jobId: job.id, claimToken: job.claim_token, status: "noop", errorCode: "canary_fence_failed" }).catch(() => false);
  }
  throw new Error("slack_canary_fence_failed");
}

async function verifyCanaryFinalFence(job: SlackUnfurlJob, deadline: number, fence: SlackCanaryExecutionFence, client: PreviewLoaderClient): Promise<void> {
  ensureWorkWindow(job, deadline, true);
  const urls = await loadSlackJobUrls(job.id, 2);
  if (urls.length !== 1 || urls[0]?.url_key !== fence.canonicalURL) await failCanaryFence(job);
  if (!(await verifySlackCanaryFixture({ job, runId: fence.runId, propertyId: fence.propertyId }))) await failCanaryFence(job);
  const freshSnapshot = await loadPreviewData({ client, orgId: job.org_id!, propertyId: fence.propertyId });
  if (!freshSnapshot || !equalCanaryPreview(freshSnapshot, fence.snapshot)) await failCanaryFence(job);
}

async function revokeWorkerInstallationGeneration(job: SlackUnfurlJob, installation: { installationId: string; installationVersion: number }, reason: string): Promise<void> {
  await revokeSlackInstallationGeneration({
    teamId: job.team_id,
    appId: job.app_id,
    installationId: installation.installationId,
    installationVersion: job.installation_version ?? installation.installationVersion,
    reason,
  }).catch(() => undefined);
}

/**
 * Process one job that has already been claimed with a valid lease.
 *
 * This is an internal server/CLI seam for run-owned acceptance checks. It
 * performs the same deadline, authorization, policy, and final dispatch
 * guards as the cron sweep; it does not claim jobs or expose an HTTP bypass.
 */
export async function processSlackUnfurlJob(job: SlackUnfurlJob, deadline: number, canaryFence?: SlackCanaryExecutionFence): Promise<"succeeded" | "noop" | "expired" | "retried" | "failed"> {
  const claimToken = job.claim_token;
  if (!claimToken) return "failed";
  if (Date.now() >= jobExpiry(job) || (job.lease_expires_at && Date.parse(job.lease_expires_at) <= Date.now())) {
    await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "expired", errorCode: "event_expired" });
    return "expired";
  }
  if (!job.installation_id || !job.org_id) {
    await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "noop", errorCode: "installation_unbound" });
    return "noop";
  }

  const installation = await loadSlackInstallation({ orgId: job.org_id, teamId: job.team_id, appId: job.app_id });
  if (!installation || installation.installationId !== job.installation_id || installation.installationVersion !== job.installation_version || installation.status !== "active" || !hasSlackPreviewScopes(installation.scopes)) {
    await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "noop", errorCode: "installation_unavailable" });
    return "noop";
  }
  const previewPolicy = await loadSlackPreviewPolicy({ installationId: installation.installationId, orgId: job.org_id });
  const expectedPolicyRevision = previewPolicy.mode === "eligible_internal_channels" ? previewPolicy.policyRevision : null;
  if (previewPolicy.mode === "disabled" || job.policy_revision !== expectedPolicyRevision) {
    await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "noop", errorCode: "preview_policy_changed" });
    return "noop";
  }
  const accountLink = await loadSlackAccountLink({ installationId: installation.installationId, orgId: job.org_id, slackUserId: job.poster_slack_user_id });
  if (!accountLink || accountLink.status !== "active") {
    await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "noop", errorCode: "poster_unbound" });
    return "noop";
  }
  if (!(await hasActiveSlackMembership({ userId: accountLink.userId, orgId: job.org_id }))) {
    await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "noop", errorCode: "poster_membership_inactive" });
    return "noop";
  }
  const approval = await loadSlackChannelApproval({ installationId: installation.installationId, orgId: job.org_id, channelId: job.channel_id });
  const channelDenied = await loadSlackChannelDenial({ installationId: installation.installationId, orgId: job.org_id, channelId: job.channel_id });
  ensureWorkWindow(job, deadline, true);
  const destination = await verifySlackDestination({ token: installation.botToken.reveal(), approval, policyEnabled: previewPolicy.mode === "eligible_internal_channels", channelDenied, installationId: installation.installationId, orgId: job.org_id, teamId: job.team_id, channelId: job.channel_id, posterUserId: job.poster_slack_user_id });
  if (!destination.allowed) {
    if (destination.reason === "installation_revoked") {
      await revokeWorkerInstallationGeneration(job, installation, destination.reason);
      await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "cancelled", errorCode: destination.reason });
      return "noop";
    }
    if (destination.reason === "slack_authority_unavailable") {
      if (canaryFence) await failCanaryFence(job);
      const next = nextRetryAt(job, Date.now(), destination.retryAfterSeconds ?? null);
      if (next.getTime() >= Date.parse(job.expires_at)) {
        await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "expired", errorCode: "authority_retry_ttl_expired" });
        return "expired";
      }
      const rescheduled = await rescheduleSlackUnfurlJob({ jobId: job.id, claimToken, nextAttemptAt: next, errorCode: "slack_authority_unavailable" });
      return rescheduled ? "retried" : "failed";
    }
    await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "noop", errorCode: destination.reason });
    return "noop";
  }

  ensureWorkWindow(job, deadline);
  const urls = await loadSlackJobUrls(job.id, canaryFence ? 2 : undefined);
  if (canaryFence && (urls.length !== 1 || urls[0]?.url_key !== canaryFence.canonicalURL)) await failCanaryFence(job);
  const client = createAdminClient() as PreviewLoaderClient;
  const unfurls: Record<string, UnfurlPayload> = {};
  let eligible = 0;
  for (const url of urls) {
    ensureWorkWindow(job, deadline);
    const parsed = parseSlackLeadUrl(url.url_key);
    if (!parsed.ok) {
      await updateSlackJobUrl({ jobId: job.id, urlKey: url.url_key, lookupStatus: "invalid", authorizationStatus: "denied", errorCode: parsed.reason });
      continue;
    }
    try {
      const snapshot = await loadPreviewData({ client, orgId: job.org_id, propertyId: parsed.link.propertyId });
      if (!snapshot) {
        if (canaryFence) await failCanaryFence(job);
        await updateSlackJobUrl({ jobId: job.id, urlKey: url.url_key, leadId: parsed.link.propertyId, lookupStatus: "unavailable", authorizationStatus: "denied", errorCode: "lead_unavailable" });
        continue;
      }
      if (canaryFence && (!snapshot || parsed.link.propertyId !== canaryFence.propertyId || !equalCanaryPreview(snapshot, canaryFence.snapshot))) await failCanaryFence(job);
      const payload = payloadForSnapshot(canaryFence?.snapshot ?? snapshot);
      unfurls[url.url_key] = payload;
      eligible += 1;
      await updateSlackJobUrl({ jobId: job.id, urlKey: url.url_key, leadId: parsed.link.propertyId, lookupStatus: "resolved", authorizationStatus: "allowed" });
    } catch (error) {
      if (isWindowError(error)) throw error;
      if (isCanaryFenceError(error)) throw error;
      if (canaryFence) await failCanaryFence(job);
      if (isTerminalSlackIdentityError(error)) {
        await revokeWorkerInstallationGeneration(job, installation, identityErrorReason(error));
        await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "cancelled", errorCode: "installation_revoked" });
        return "noop";
      }
      const next = nextRetryAt(job, Date.now(), null);
      await rescheduleSlackUnfurlJob({ jobId: job.id, claimToken, nextAttemptAt: next, errorCode: "preview_load_failed" });
      return "retried";
    }
  }
  if (eligible === 0) {
    await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "noop", errorCode: "no_authorized_links" });
    return "noop";
  }

  // CRM loading may be paused for several seconds. Recheck the work window,
  // then ask Slack again and fence the claim against current DB authority
  // immediately before sending any rendered content.
  ensureWorkWindow(job, deadline, true);
  const finalDestination = await verifySlackDestination({ token: installation.botToken.reveal(), approval: await loadSlackChannelApproval({ installationId: installation.installationId, orgId: job.org_id, channelId: job.channel_id }), policyEnabled: previewPolicy.mode === "eligible_internal_channels", channelDenied: await loadSlackChannelDenial({ installationId: installation.installationId, orgId: job.org_id, channelId: job.channel_id }), installationId: installation.installationId, orgId: job.org_id, teamId: job.team_id, channelId: job.channel_id, posterUserId: job.poster_slack_user_id });
  if (!finalDestination.allowed) {
    if (finalDestination.reason === "installation_revoked") {
      await revokeWorkerInstallationGeneration(job, installation, finalDestination.reason);
      await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "cancelled", errorCode: finalDestination.reason });
      return "noop";
    }
    if (finalDestination.reason === "slack_authority_unavailable") {
      if (canaryFence) await failCanaryFence(job);
      const next = nextRetryAt(job, Date.now(), finalDestination.retryAfterSeconds ?? null);
      if (next.getTime() >= jobExpiry(job)) {
        await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "expired", errorCode: "authority_retry_ttl_expired" });
        return "expired";
      }
      const rescheduled = await rescheduleSlackUnfurlJob({ jobId: job.id, claimToken, nextAttemptAt: next, errorCode: "slack_authority_unavailable" });
      return rescheduled ? "retried" : "failed";
    }
    await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "noop", errorCode: finalDestination.reason });
    return "noop";
  }
  ensureWorkWindow(job, deadline, true);
  const dispatchGuard = await guardSlackUnfurlDispatch({ jobId: job.id, claimToken, installationId: installation.installationId, installationVersion: job.installation_version ?? installation.installationVersion, orgId: job.org_id, channelId: job.channel_id, posterSlackUserId: job.poster_slack_user_id });
  if (!dispatchGuard) {
    await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "noop", errorCode: "dispatch_guard_failed" });
    return "noop";
  }

  if (canaryFence) {
    try {
      await verifyCanaryFinalFence(job, deadline, canaryFence, client);
    } catch (error) {
      if (isCanaryFenceError(error)) throw error;
      if (isWindowError(error)) throw error;
      await failCanaryFence(job);
    }
  }

  try {
    ensureWorkWindow(job, deadline, true);
    const slack = new WebClient(installation.botToken.reveal(), { timeout: 5000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });
    const response = await slack.chat.unfurl({ channel: job.channel_id, ts: job.message_ts, unfurls });
    if (!response.ok) throw new Error(`slack_unfurl_failed:${response.error ?? "unknown"}`);
    await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "succeeded" });
    return "succeeded";
  } catch (error) {
    if (isWindowError(error)) throw error;
    if (isTerminalSlackIdentityError(error)) {
      await revokeWorkerInstallationGeneration(job, installation, identityErrorReason(error));
      await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "cancelled", errorCode: "installation_revoked" });
      return "noop";
    }
    const terminalError = slackApiErrorCode(error);
    if (terminalError && TERMINAL_SLACK_UNFURL_ERRORS.has(terminalError)) {
      await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "noop", errorCode: `slack_${terminalError}` });
      return "noop";
    }
    if (canaryFence) await failCanaryFence(job);
    const next = nextRetryAt(job, Date.now(), retryAfterSeconds(error));
    if (next.getTime() >= Date.parse(job.expires_at)) {
      await finishSlackUnfurlJob({ jobId: job.id, claimToken, status: "expired", errorCode: "retry_ttl_expired" });
      return "expired";
    }
    const rescheduled = await rescheduleSlackUnfurlJob({ jobId: job.id, claimToken, nextAttemptAt: next, errorCode: "slack_unfurl_failed" });
    return rescheduled ? "retried" : "failed";
  }
}

export async function runSlackUnfurlSweep(): Promise<SlackSweepSummary> {
  const started = Date.now();
  const deadline = started + WORK_BUDGET_MS - LEASE_RESERVE_MS;
  const summary: SlackSweepSummary = { claimed: 0, succeeded: 0, noops: 0, expired: 0, retried: 0, failed: 0, cleaned: 0 };
  summary.cleaned = await cleanupSlackUnfurlData(new Date(started - 7 * 24 * 60 * 60 * 1000));
  if (process.env.SLACK_LEAD_UNFURL_ENABLED !== "1") return summary;
  const jobs = await claimSlackUnfurlJobs({ limit: 10, leaseSeconds: 90 });
  summary.claimed = jobs.length;
  for (const [index, job] of jobs.entries()) {
    if (Date.now() >= deadline) {
      await Promise.all(jobs.slice(index).map((unprocessed) => unprocessed.claim_token
        ? releaseSlackUnfurlJobClaim({ jobId: unprocessed.id, claimToken: unprocessed.claim_token }).catch(() => false)
        : Promise.resolve(false)));
      break;
    }
    try {
      const status = await processSlackUnfurlJob(job, deadline);
      summary[status === "succeeded" ? "succeeded" : status === "noop" ? "noops" : status] += 1;
    } catch (error) {
      if (error instanceof Error && error.message === "slack_unfurl_budget_exhausted") {
        const currentClaimToken = job.claim_token;
        if (currentClaimToken) await releaseSlackUnfurlJobClaim({ jobId: job.id, claimToken: currentClaimToken }).catch(() => false);
        for (const unprocessed of jobs.slice(index + 1)) {
          const unprocessedClaimToken = unprocessed.claim_token;
          if (unprocessedClaimToken) await releaseSlackUnfurlJobClaim({ jobId: unprocessed.id, claimToken: unprocessedClaimToken }).catch(() => false);
        }
        break;
      }
      if (error instanceof Error && error.message === "slack_unfurl_expired") {
        if (job.claim_token) await finishSlackUnfurlJob({ jobId: job.id, claimToken: job.claim_token, status: "expired", errorCode: "work_window_expired" }).catch(() => false);
        summary.expired += 1;
        continue;
      }
      summary.failed += 1;
      if (job.claim_token) {
        await rescheduleSlackUnfurlJob({ jobId: job.id, claimToken: job.claim_token, nextAttemptAt: nextRetryAt(job, Date.now(), null), errorCode: "worker_error" }).catch(() => undefined);
      }
    }
  }
  return summary;
}
