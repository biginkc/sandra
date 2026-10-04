import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  verifySlackCanaryFixture,
} from "@/lib/integrations/slack/unfurl-canary";
import {
  loadSlackJobUrls,
  loadSlackUnfurlJob,
  loadSlackUnfurlReceiptIdentity,
} from "@/lib/integrations/slack/unfurl-store";
import { parseSlackLeadUrl } from "@/lib/integrations/slack/unfurl-policy";
import { processSlackUnfurlJob } from "@/lib/integrations/slack/unfurl-worker";

export const maxDuration = 45;

const MAX_BODY_BYTES = 8 * 1024;
const BODY_READ_TIMEOUT_MS = 5_000;
const MAX_LEASE_MS = 120_000;
const WORK_BUDGET_MS = 40_000;
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
}, now: number): number | null {
  if (job.status !== "processing" || job.attempts !== 1 || !job.lease_expires_at) return null;
  const leaseExpiresAt = Date.parse(job.lease_expires_at);
  const expiry = jobExpiry(job);
  if (!Number.isFinite(leaseExpiresAt) || !Number.isFinite(expiry)) return null;
  if (leaseExpiresAt <= now || expiry <= now || leaseExpiresAt - now > MAX_LEASE_MS) return null;
  const deadline = Math.min(now + WORK_BUDGET_MS, leaseExpiresAt - LEASE_RESERVE_MS, expiry - LEASE_RESERVE_MS);
  return deadline > now ? deadline : null;
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return response(500, { error: "CRON_SECRET not configured" });
  const authorization = request.headers.get("authorization");
  if (!authorization || !authorization.startsWith("Bearer ") || !equalSecret(authorization.slice(7), secret)) {
    return response(401, { error: "Unauthorized" });
  }
  if (!contentTypeAllowed(request)) return refusal("invalid_content_type");

  const body = await readBoundedBody(request);
  if (!body.ok) return refusal("invalid_body");
  const payload = parsePayload(body.text);
  if (!payload) return refusal("invalid_request");

  try {
    const job = await loadSlackUnfurlJob(payload.jobId);
    if (!job || job.id !== payload.jobId || job.installation_id !== payload.installationId || job.org_id !== payload.orgId || job.channel_id !== payload.channelId || job.message_ts !== payload.messageTs || job.poster_slack_user_id !== payload.posterId) return refusal();
    if (!job.claim_token || !equalClaimToken(job.claim_token, payload.claimToken)) return refusal();

    const receipt = await loadSlackUnfurlReceiptIdentity(job.receipt_id);
    // Slack owns the receipt event id, so it cannot carry the synthetic run
    // marker. The run marker is proved against the property/contact fixture
    // below; here we only require the job's persisted receipt to still exist.
    if (!receipt || receipt.id !== job.receipt_id) return refusal();

    const urls = await loadSlackJobUrls(job.id);
    if (urls.length !== 1 || urls[0]?.url_key !== payload.canonicalURL) return refusal();
    const deadline = currentWorkerDeadline(job, Date.now());
    if (deadline === null) return refusal();
    const verified = await verifySlackCanaryFixture({ job, runId: payload.runId, propertyId: payload.propertyId });
    if (!verified) return refusal();

    const status = await processSlackUnfurlJob(job, deadline);
    return response(200, { ok: true, status });
  } catch {
    // Do not serialize provider errors, credentials, claims, or raw database
    // rows. The durable job state remains the source of truth for diagnosis.
    return response(500, { ok: false, stage: "worker", category: "internal_error" });
  }
}
