import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { verifySlackSignature } from "@/lib/integrations/slack/signature";
import {
  eventChannel,
  eventLinks,
  eventMessageTs,
  eventPoster,
  eventSource,
  eventType,
  handleLifecycleSlackEvent,
  isLifecycleSlackEvent,
  isLinkSharedSlackEvent,
  parseSlackEventsBody,
  SLACK_EVENT_BODY_LIMIT,
  type SlackEventEnvelope,
  type SlackUrlVerification,
} from "@/lib/integrations/slack/events";
import { parseSlackLeadLinks } from "@/lib/integrations/slack/unfurl-policy";
import { enqueueSlackUnfurlEvent, findSlackInstallations, isSlackUnfurlInstallationStaleError } from "@/lib/integrations/slack/unfurl-store";

export const maxDuration = 10;

const FLAG_ENABLED = "1";
// Slack retries quickly; reserve a bounded response window for every lookup,
// RPC, and deliberate receipt so an accepted event is never acknowledged
// before its durable job exists.
const WEBHOOK_BUDGET_MS = 2_500;

async function withinWebhookDeadline<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("slack_webhook_deadline_exhausted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Start the operation only after the budget check, and turn synchronous
    // throws into a promise so the race observes late rejections too.
    const operationPromise = Promise.resolve().then(operation);
    return await Promise.race([
      operationPromise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("slack_webhook_deadline_exhausted")), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function noOp() {
  return NextResponse.json({ ok: true });
}

function configuredAppId(): string | null {
  // Slack's api_app_id (A...) is distinct from the OAuth client_id, which is
  // commonly a numeric dotted value. Never compare the two.
  const appId = process.env.SLACK_APP_ID;
  return appId && appId.length <= 128 ? appId : null;
}

async function recordNoOp(body: SlackEventEnvelope, reason: string, deadline: number): Promise<Response> {
  const teamId = body.team_id;
  const appId = body.api_app_id;
  const eventId = body.event_id;
  if (!teamId || !appId || !eventId) return noOp();
  try {
    await withinWebhookDeadline(() => enqueueSlackUnfurlEvent({
      teamId,
      appId,
      eventId,
      eventType: eventType(body),
      eventTime: typeof body.event_time === "number" ? new Date(body.event_time * 1000).toISOString() : null,
      orgId: null,
      installationId: null,
      installationVersion: null,
      channelId: eventChannel(body),
      messageTs: eventMessageTs(body),
      posterSlackUserId: eventPoster(body),
      urlKeys: [],
      denialCode: reason,
    }), deadline);
    return noOp();
  } catch (error) {
    reportError(error, { tags: { surface: "slack_events_receipt" }, extra: { teamId, eventId, reason } });
    // Denials and disabled/unsupported events are deliberate no-ops. A
    // logging failure must not trigger Slack's retry storm or turn a denied
    // message into an accepted delivery.
    return noOp();
  }
}

async function handleEnvelope(body: SlackEventEnvelope, deadline: number): Promise<Response> {
  const teamId = body.team_id;
  const appId = body.api_app_id;
  const eventId = body.event_id;
  if (!teamId || !appId || !eventId) return NextResponse.json({ error: "malformed_envelope" }, { status: 400 });
  const type = eventType(body);

  // Signed lifecycle events remain active while previews are disabled so a
  // revoked installation cannot leave pending jobs or approvals live.
  if (isLifecycleSlackEvent(type)) {
    try {
      await withinWebhookDeadline(() => handleLifecycleSlackEvent(body), deadline);
    } catch {
      return NextResponse.json({ error: "temporary_lifecycle_failure" }, { status: 503 });
    }
    return recordNoOp(body, "lifecycle_processed", deadline);
  }

  if (!isLinkSharedSlackEvent(type)) return recordNoOp(body, "unsupported_event", deadline);
  if (process.env.SLACK_LEAD_UNFURL_ENABLED !== FLAG_ENABLED) return recordNoOp(body, "feature_disabled", deadline);
  if (eventChannel(body)?.startsWith("D")) return recordNoOp(body, "private_channel_denied", deadline);
  if (eventChannel(body) === "COMPOSER" || eventSource(body)?.toLowerCase() === "composer") return recordNoOp(body, "composer_denied", deadline);

  const rawLinks = eventLinks(body);
  const parsed = parseSlackLeadLinks(rawLinks);
  if (parsed.overLimit) return recordNoOp(body, "link_limit_exceeded", deadline);
  if (parsed.links.length === 0) return recordNoOp(body, "unsupported_link", deadline);
  const channelId = eventChannel(body);
  const poster = eventPoster(body);
  const messageTs = eventMessageTs(body);
  if (!channelId || !poster || !messageTs) return recordNoOp(body, "missing_destination", deadline);

  let installations;
  try {
    installations = (await withinWebhookDeadline(() => findSlackInstallations(teamId, appId), deadline)).filter((row) => row.status === "active");
  } catch (error) {
    reportError(error, { tags: { surface: "slack_events_installation_lookup" }, extra: { teamId, eventId } });
    return NextResponse.json({ error: "temporary_receipt_failure" }, { status: 503 });
  }
  if (installations.length !== 1) return recordNoOp(body, installations.length === 0 ? "installation_missing" : "installation_ambiguous", deadline);
  const installation = installations[0];
  try {
    const enqueued = await withinWebhookDeadline(() => enqueueSlackUnfurlEvent({
      teamId,
      appId,
      eventId,
      eventType: type,
      eventTime: typeof body.event_time === "number" ? new Date(body.event_time * 1000).toISOString() : null,
      orgId: installation.orgId,
      installationId: installation.installationId,
      installationVersion: installation.installationVersion,
      channelId,
      messageTs,
      posterSlackUserId: poster,
      urlKeys: parsed.links.map((link) => link.originalUrl),
    }), deadline);
    if (!enqueued.jobId && !enqueued.duplicate) throw new Error("accepted Slack event did not receive durable job");
    return noOp();
  } catch (error) {
    if (isSlackUnfurlInstallationStaleError(error)) return recordNoOp(body, "installation_stale", deadline);
    reportError(error, { tags: { surface: "slack_events_enqueue" }, extra: { teamId, eventId, installationId: installation.installationId } });
    return NextResponse.json({ error: "temporary_enqueue_failure" }, { status: 503 });
  }
}

export async function POST(request: Request): Promise<Response> {
  const deadline = Date.now() + WEBHOOK_BUDGET_MS;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > SLACK_EVENT_BODY_LIMIT) return NextResponse.json({ error: "body_too_large" }, { status: 413 });
  let rawBody: string;
  try {
    rawBody = await withinWebhookDeadline(() => request.text(), deadline);
  } catch {
    return NextResponse.json({ error: "temporary_request_timeout" }, { status: 503 });
  }
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret || !verifySlackSignature({ signingSecret: secret, timestamp: request.headers.get("x-slack-request-timestamp"), signature: request.headers.get("x-slack-signature"), rawBody })) return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  if (Buffer.byteLength(rawBody, "utf8") > SLACK_EVENT_BODY_LIMIT) return NextResponse.json({ error: "body_too_large" }, { status: 413 });
  const body = parseSlackEventsBody(rawBody);
  if (!body) return NextResponse.json({ error: "malformed_body" }, { status: 400 });
  const expectedAppId = configuredAppId();
  if (expectedAppId && body.api_app_id && body.api_app_id !== expectedAppId) {
    if (body.type === "event_callback") return recordNoOp(body, "wrong_app", deadline);
    return noOp();
  }
  if (body.type === "url_verification") return NextResponse.json({ challenge: (body as SlackUrlVerification).challenge });
  return handleEnvelope(body, deadline);
}
