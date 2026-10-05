import { randomUUID, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  freezeSlackCanaryPreview,
  loadSlackCanaryPreview,
  verifySlackCanaryFixture,
} from "@/lib/integrations/slack/unfurl-canary";
import {
  claimSlackCanaryExecution,
  loadSlackJobUrls,
  loadSlackUnfurlJob,
  loadSlackUnfurlReceiptIdentity,
  finishSlackUnfurlJob,
} from "@/lib/integrations/slack/unfurl-store";
import { parseSlackLeadUrl } from "@/lib/integrations/slack/unfurl-policy";
import { processSlackUnfurlJob, type SlackCanaryExecutionFence } from "@/lib/integrations/slack/unfurl-worker";

export const maxDuration = 45;

const MAX_BODY_BYTES = 8 * 1024;
const BODY_READ_TIMEOUT_MS = 5_000;
const HANDLER_BUDGET_MS = 35_000;
const MAX_LEASE_MS = 120_000;
const LEASE_RESERVE_MS = 5_000;
const JOB_TTL_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLACK_CHANNEL_ID = /^[A-Z][A-Z0-9]{2,31}$/;
const SLACK_USER_ID = /^U[A-Z0-9]{2,31}$/;
const SLACK_TS = /^\d{1,20}\.\d{1,9}$/;

const REQUIRED_FIELDS = [
  "mode",
  "runId",
  "jobId",
  "claimToken",
  "propertyId",
  "canonicalURL",
  "installationId",
  "orgId",
  "channelId",
  "messageTs",
  "posterId",
] as const;

type CanaryPayload = {
  mode: "exact_job";
  runId: string;
  jobId: string;
  claimToken: string;
  propertyId: string;
  canonicalURL: string;
  installationId: string;
  orgId: string;
  channelId: string;
  messageTs: string;
  posterId: string;
};

type ReadBodyResult =
  | { ok: true; text: string }
  | { ok: false };

async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("slack_canary_body_timeout")), timeoutMs);
      reader.read().then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function response(status: number, body: Record<string, unknown>): Response {
  return NextResponse.json(body, { status });
}

function refusal(category = "refused"): Response {
  return response(409, { ok: false, stage: "preflight", category });
}

function contentTypeAllowed(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return contentType !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType);
}

async function readBoundedBody(request: Request): Promise<ReadBodyResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    return { ok: false };
  }
  if (!request.body) return { ok: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + BODY_READ_TIMEOUT_MS;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        void reader.cancel();
        return { ok: false };
      }
      const next = await readChunkWithTimeout(reader, remaining);
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        void reader.cancel();
        return { ok: false };
      }
      chunks.push(next.value);
    }
  } catch {
    void reader.cancel();
    return { ok: false };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function parsePayload(text: string): CanaryPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const expected = [...REQUIRED_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  if (value.mode !== "exact_job") return null;
  if (!isUuid(value.runId) || !isUuid(value.jobId) || !isUuid(value.claimToken) || !isUuid(value.propertyId) || !isUuid(value.installationId) || !isUuid(value.orgId)) return null;
  if (typeof value.canonicalURL !== "string" || value.canonicalURL.length > 3_000) return null;
  if (typeof value.channelId !== "string" || !SLACK_CHANNEL_ID.test(value.channelId)) return null;
  if (typeof value.messageTs !== "string" || !SLACK_TS.test(value.messageTs)) return null;
  if (typeof value.posterId !== "string" || !SLACK_USER_ID.test(value.posterId)) return null;
  const parsed = parseSlackLeadUrl(value.canonicalURL);
  // The route accepts only the exact persisted URL whose parser resolves to
  // the supplied property; the worker repeats this binding before rendering.
  if (!parsed.ok || parsed.link.propertyId !== value.propertyId.toLowerCase() || parsed.link.originalUrl !== value.canonicalURL) return null;
  return value as CanaryPayload;
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function equalClaimToken(left: string, right: string): boolean {
  return equalSecret(left, right);
}

function jobExpiry(job: { event_time: string; expires_at: string }): number {
  const eventTime = Date.parse(job.event_time);
  const expiresAt = Date.parse(job.expires_at);
  if (!Number.isFinite(eventTime) || !Number.isFinite(expiresAt)) return Number.NaN;
  return Math.min(expiresAt, eventTime + JOB_TTL_MS);
}

function currentWorkerDeadline(job: {
  status: string;
  attempts: number;
  lease_expires_at: string | null;
  event_time: string;
  expires_at: string;
}, now: number, handlerDeadline: number): number | null {
  if (job.status !== "processing" || job.attempts !== 1 || !job.lease_expires_at) return null;
  const leaseExpiresAt = Date.parse(job.lease_expires_at);
  const expiry = jobExpiry(job);
  if (!Number.isFinite(leaseExpiresAt) || !Number.isFinite(expiry)) return null;
  if (leaseExpiresAt <= now || expiry <= now || leaseExpiresAt - now > MAX_LEASE_MS) return null;
  const deadline = Math.min(handlerDeadline, leaseExpiresAt - LEASE_RESERVE_MS, expiry - LEASE_RESERVE_MS);
  return deadline > now ? deadline : null;
}

function isWindowError(error: unknown): boolean {
  return error instanceof Error && (error.message === "slack_unfurl_expired" || error.message === "slack_unfurl_budget_exhausted");
}

async function finishWorkWindowClaim(jobId: string, claimToken: string): Promise<void> {
  await finishSlackUnfurlJob({ jobId, claimToken, status: "expired", errorCode: "work_window_expired" }).catch(() => false);
}

async function finishCanaryClaim(jobId: string, claimToken: string, errorCode: string): Promise<void> {
  await finishSlackUnfurlJob({ jobId, claimToken, status: "noop", errorCode }).catch(() => false);
}

async function expireIfHandlerWindowElapsed(
  job: { id: string; status: string; attempts: number },
  claimToken: string,
  handlerDeadline: number,
  now: number,
): Promise<boolean> {
  if (job.status !== "processing" || job.attempts !== 1 || now < handlerDeadline) return false;
  await finishWorkWindowClaim(job.id, claimToken);
  return true;
}

function workWindowRefusal(stage: "preflight" | "worker" = "preflight"): Response {
  return response(409, { ok: false, stage, category: "work_window" });
}

function canaryFenceRefusal(stage: "preflight" | "worker" = "preflight"): Response {
  return response(409, { ok: false, stage, category: "canary_fence" });
}

function canaryDispatchRefusal(): Response {
  return response(500, { ok: false, stage: "dispatch", category: "outcome_unknown" });
}

function isCanaryDispatchError(error: unknown): boolean {
  return error instanceof Error && (error.message === "slack_canary_dispatch_unknown" || error.message === "slack_canary_dispatch_unrecorded");
}

export async function POST(request: Request): Promise<Response> {
  const handlerStartedAt = Date.now();
  const secret = process.env.CRON_SECRET;
  if (!secret) return response(500, { error: "CRON_SECRET not configured" });
  const authorization = request.headers.get("authorization");
  if (!authorization || !authorization.startsWith("Bearer ") || !equalSecret(authorization.slice(7), secret)) {
    return response(401, { error: "Unauthorized" });
  }
  if (!contentTypeAllowed(request)) return refusal("invalid_content_type");

  const body = await readBoundedBody(request);
  if (!body.ok) return refusal("invalid_body");
  const parsedPayload = parsePayload(body.text);
  if (!parsedPayload) return refusal("invalid_request");

  let job: Awaited<ReturnType<typeof loadSlackUnfurlJob>>;
  const payload: CanaryPayload = parsedPayload;
  let deadline: number;
  let canaryFence: SlackCanaryExecutionFence;
  let privateClaimToken = "";
  let canaryTargetTrusted = false;
  let privateClaimAttempted = false;
  try {
    job = await loadSlackUnfurlJob(payload.jobId);
    if (!job || job.id !== payload.jobId || job.installation_id !== payload.installationId || job.org_id !== payload.orgId || job.channel_id !== payload.channelId || job.message_ts !== payload.messageTs || job.poster_slack_user_id !== payload.posterId) return refusal();
    if (!job.claim_token || !equalClaimToken(job.claim_token, payload.claimToken)) return refusal();

    const receipt = await loadSlackUnfurlReceiptIdentity(job.receipt_id);
    // Slack owns the receipt event id, so it cannot carry the synthetic run
    // marker. The run marker is proved against the property/contact fixture
    // below; here we only require the job's persisted receipt to still exist.
    if (!receipt || receipt.id !== job.receipt_id) return refusal();

    const urls = await loadSlackJobUrls(job.id, 2);
    if (urls.length !== 1 || urls[0]?.url_key !== payload.canonicalURL) return refusal();
    // Before this point the caller has not proved ownership of the persisted
    // exact URL/receipt pair, so mismatches must remain non-mutating refusals.
    canaryTargetTrusted = true;
    const now = Date.now();
    const handlerDeadline = handlerStartedAt + HANDLER_BUDGET_MS;
    const workerDeadline = currentWorkerDeadline(job, now, handlerDeadline);
    if (workerDeadline === null) {
      if (await expireIfHandlerWindowElapsed(job, payload.claimToken, handlerDeadline, now)) return workWindowRefusal();
      // The exact persisted job and original claim are already bound above.
      // A processing/attempt-one job that fails the bounded lease/TTL fence
      // must become terminal instead of remaining requeueable synthetic work.
      if (job.status === "processing" && job.attempts === 1) {
        await finishCanaryClaim(job.id, payload.claimToken, "canary_preflight_failed");
      }
      return refusal();
    }
    const verified = await verifySlackCanaryFixture({ job, runId: payload.runId, propertyId: payload.propertyId });
    const afterPreflight = Date.now();
    if (await expireIfHandlerWindowElapsed(job, payload.claimToken, handlerDeadline, afterPreflight)) return workWindowRefusal();
    if (!verified) {
      await finishCanaryClaim(job.id, payload.claimToken, "canary_preflight_failed");
      return canaryFenceRefusal();
    }
    const snapshot = await loadSlackCanaryPreview({ job, propertyId: payload.propertyId });
    if (!snapshot) {
      await finishCanaryClaim(job.id, payload.claimToken, "canary_preflight_failed");
      return canaryFenceRefusal();
    }
    const fixtureAfterCapture = await verifySlackCanaryFixture({ job, runId: payload.runId, propertyId: payload.propertyId });
    const afterCapture = Date.now();
    if (await expireIfHandlerWindowElapsed(job, payload.claimToken, handlerDeadline, afterCapture)) return workWindowRefusal();
    if (!fixtureAfterCapture) {
      await finishCanaryClaim(job.id, payload.claimToken, "canary_preflight_failed");
      return canaryFenceRefusal();
    }
    const refreshedDeadline = currentWorkerDeadline(job, afterCapture, handlerDeadline);
    if (refreshedDeadline === null) {
      await finishCanaryClaim(job.id, payload.claimToken, "canary_preflight_failed");
      return refusal();
    }
    deadline = refreshedDeadline;
    privateClaimToken = randomUUID();
    // The RPC may commit and then lose its response. Mark ownership before
    // awaiting it so an ambiguous outcome can only attempt private-token
    // cleanup, never mutate the original caller claim.
    privateClaimAttempted = true;
    const claimed = await claimSlackCanaryExecution({
      jobId: job.id,
      claimToken: payload.claimToken,
      privateClaimToken,
      orgId: payload.orgId,
      propertyId: payload.propertyId,
      runId: payload.runId,
      canonicalURL: payload.canonicalURL,
    });
    if (!claimed) {
      // A definitive false is token-conditioned in SQL: it either observes a
      // drifted fixture or loses the row lock to a private-token winner. The
      // original-token finish is therefore a no-op for the winner and
      // terminalizes an otherwise requeueable exact synthetic job.
      await finishCanaryClaim(job.id, payload.claimToken, "canary_preflight_failed");
      return canaryFenceRefusal();
    }
    canaryFence = {
      canonicalURL: payload.canonicalURL,
      propertyId: payload.propertyId.toLowerCase(),
      runId: payload.runId,
      snapshot: freezeSlackCanaryPreview(snapshot),
    };
  } catch {
    if (privateClaimAttempted) await finishCanaryClaim(payload.jobId, privateClaimToken, "canary_preflight_failed");
    else if (canaryTargetTrusted) await finishCanaryClaim(payload.jobId, payload.claimToken, "canary_preflight_failed");
    return response(500, { ok: false, stage: "preflight", category: "internal_error" });
  }

  try {
    const claimedJob = { ...job, claim_token: privateClaimToken };
    const status = await processSlackUnfurlJob(claimedJob, deadline as number, canaryFence);
    try {
      const [urls, fixtureStillOwned] = await Promise.all([
        loadSlackJobUrls(job.id, 2),
        verifySlackCanaryFixture({ job, runId: payload.runId, propertyId: payload.propertyId }),
      ]);
      if (urls.length !== 1 || urls[0]?.url_key !== payload.canonicalURL || !fixtureStillOwned) {
        return response(409, { ok: false, stage: "post_dispatch", category: "post_dispatch_drift" });
      }
    } catch {
      return response(500, { ok: false, stage: "post_dispatch", category: "internal_error" });
    }
    return response(200, { ok: true, status });
  } catch (error) {
    if (isCanaryDispatchError(error)) return canaryDispatchRefusal();
    if (error instanceof Error && error.message === "slack_canary_fence_failed") return canaryFenceRefusal("worker");
    if (isWindowError(error)) {
      await finishWorkWindowClaim(job.id, privateClaimToken);
      return workWindowRefusal("worker");
    }
    // Do not serialize provider errors, credentials, claims, or raw database
    // rows. The durable job state remains the source of truth for diagnosis.
    await finishCanaryClaim(job.id, privateClaimToken, "canary_worker_failed");
    return response(500, { ok: false, stage: "worker", category: "internal_error" });
  }
}
