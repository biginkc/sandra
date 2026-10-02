import type { SupabaseClient } from "@supabase/supabase-js";
import { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import type { NormaEnv } from "./config";
import {
  buildNormaLeadDeepLink,
  buildNormaSummaryBlocks,
  buildNormaSummaryFallbackText,
} from "./slack-blocks";

type Client = SupabaseClient<Database>;

export type NormaSlackPost = (message: { blocks: KnownBlock[]; text: string }) => Promise<{ ts: string }>;

export type NormaSlackConfig = { botToken: string; channelId: string };

/** Both values come from env at deploy; never hardcoded. Null when either is unset. */
export function readNormaSlackConfig(env: NormaEnv = process.env): NormaSlackConfig | null {
  const botToken = env.NORMA_SLACK_BOT_TOKEN?.trim();
  const channelId = env.NORMA_SLACK_CHANNEL_ID?.trim();
  return botToken && channelId ? { botToken, channelId } : null;
}

/** One bounded attempt per call: backoff lives in the outbox, not in the SDK. */
export function createNormaSlackPoster(config: NormaSlackConfig): NormaSlackPost {
  const slack = new WebClient(config.botToken, { timeout: SLACK_POST_TIMEOUT_MS, retryConfig: { retries: 0 } });
  return async ({ blocks, text }) => {
    const posted = await slack.chat.postMessage({
      channel: config.channelId,
      blocks,
      text,
      // Seller-supplied text can contain links; never let Slack fetch or expand them.
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!posted.ok || !posted.ts) throw new Error(`slack_post_failed:${posted.error ?? "no_ts"}`);
    return { ts: posted.ts };
  };
}

const MIN = 60_000;
/** Delay after the Nth failed attempt (1-based); the last value repeats. */
export const NORMA_NOTIFICATION_BACKOFF_MS = [1 * MIN, 5 * MIN, 15 * MIN, 60 * MIN, 3 * 60 * MIN, 6 * 60 * MIN] as const;
export const NORMA_NOTIFICATION_MAX_ATTEMPTS = 10;
/**
 * A row is leased (next_attempt_at pushed out) before it is posted, so two
 * overlapping runs cannot both post it, and a run that dies mid-post is retried
 * after the lease expires.
 */
export const NORMA_NOTIFICATION_LEASE_MS = 5 * MIN;
/** Rows per run. Small on purpose: each post can take up to the Slack timeout. */
const BATCH = 10;
const SLACK_POST_TIMEOUT_MS = 10_000;
/** The cron route's maxDuration is 60s; stay well inside it. */
export const NORMA_NOTIFICATION_RUN_BUDGET_MS = 45_000;
/** No new row is started unless a worst-case post (timeout + message reads) still fits the budget. */
export const NORMA_NOTIFICATION_ROW_RESERVE_MS = SLACK_POST_TIMEOUT_MS + 3_000;

export function normaNotificationBackoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), NORMA_NOTIFICATION_BACKOFF_MS.length) - 1;
  return NORMA_NOTIFICATION_BACKOFF_MS[index];
}

export type NormaNotificationSummary = {
  configured: boolean;
  scanned: number;
  sent: number;
  failed: number;
  gaveUp: number;
  skipped: number;
  /** Posted, but the sent-write failed: the lease is kept, nothing is re-posted this run. */
  unrecorded: number;
  /** Left untouched (still pending) because the run budget was spent. */
  deferred: number;
};

export type NormaNotificationDeps = {
  client: Client;
  /** Null when the Slack env is unset: the worker then does nothing and leaves rows pending. */
  post: NormaSlackPost | null;
  now?: number;
  env?: NormaEnv;
  /** Wall clock for the run budget (tests inject one). Distinct from `now`, which dates the rows. */
  clock?: () => number;
  budgetMs?: number;
};

type NotificationRow = Pick<
  Database["public"]["Tables"]["norma_notifications"]["Row"],
  "id" | "request_id" | "attempts" | "next_attempt_at"
>;

/**
 * Drains `norma_notifications` (Slack outbox). Touches only that table: it
 * never writes CRM state. One post per notification row.
 */
export async function drainNormaNotifications(deps: NormaNotificationDeps): Promise<NormaNotificationSummary> {
  const summary: NormaNotificationSummary = { configured: deps.post !== null, scanned: 0, sent: 0, failed: 0, gaveUp: 0, skipped: 0, unrecorded: 0, deferred: 0 };
  if (!deps.post) return summary;
  const now = deps.now ?? Date.now();
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const budgetMs = deps.budgetMs ?? NORMA_NOTIFICATION_RUN_BUDGET_MS;

  const { data, error } = await deps.client
    .from("norma_notifications")
    .select("id, request_id, attempts, next_attempt_at")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date(now).toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(BATCH);
  if (error) throw new Error(`norma notifications scan failed: ${error.message}`);

  const rows = (data ?? []) as NotificationRow[];
  for (const [index, row] of rows.entries()) {
    // Never begin a post the 60s function limit could kill half way through.
    if (clock() - startedAt > budgetMs - NORMA_NOTIFICATION_ROW_RESERVE_MS) {
      summary.deferred = rows.length - index;
      break;
    }
    summary.scanned += 1;
    const claimed = await claim(deps.client, row, now);
    if (!claimed) {
      summary.skipped += 1;
      continue;
    }
    let ts: string;
    try {
      const message = await buildMessage(deps.client, row.request_id, deps.env);
      ({ ts } = await deps.post(message));
    } catch (failure) {
      const attempts = row.attempts + 1;
      const giveUp = attempts >= NORMA_NOTIFICATION_MAX_ATTEMPTS;
      reportError(failure, { tags: { surface: "norma_slack_notification" }, extra: { notificationId: row.id, attempts } });
      await markFailed(deps.client, row.id, attempts, giveUp, now, failure);
      if (giveUp) summary.gaveUp += 1;
      else summary.failed += 1;
      continue;
    }
    // Only a failed POST is a failure. Once Slack has the message, a bookkeeping
    // error must not back the row off into a re-post: keep the lease, report it.
    try {
      await markSent(deps.client, row.id, ts, row.attempts + 1, now);
      summary.sent += 1;
    } catch (bookkeeping) {
      summary.unrecorded += 1;
      reportError(bookkeeping, { tags: { surface: "norma_slack_notification_sent_write" }, extra: { notificationId: row.id, slackTs: ts } });
    }
  }
  return summary;
}

/** Optimistic lease: succeeds only if nobody else moved the row since it was read. */
async function claim(client: Client, row: NotificationRow, now: number): Promise<boolean> {
  const { data, error } = await client
    .from("norma_notifications")
    .update({ next_attempt_at: new Date(now + NORMA_NOTIFICATION_LEASE_MS).toISOString(), updated_at: new Date(now).toISOString() })
    .eq("id", row.id)
    .eq("status", "pending")
    .eq("next_attempt_at", row.next_attempt_at)
    .select("id");
  if (error) throw new Error(`norma notification claim failed: ${error.message}`);
  return (data?.length ?? 0) === 1;
}

async function markSent(client: Client, id: string, ts: string, attempts: number, now: number) {
  // The post already succeeded: retry the bookkeeping once rather than risk a repeat post.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error } = await client
      .from("norma_notifications")
      .update({ status: "sent", slack_ts: ts, attempts, last_error: null, updated_at: new Date(now).toISOString() })
      .eq("id", id);
    if (!error) return;
    if (attempt === 1) throw new Error(`norma notification sent-write failed: ${error.message}`);
  }
}

async function markFailed(client: Client, id: string, attempts: number, giveUp: boolean, now: number, failure: unknown) {
  const message = failure instanceof Error ? failure.message : "unknown_error";
  const { error } = await client
    .from("norma_notifications")
    .update({
      status: giveUp ? "failed" : "pending",
      attempts,
      next_attempt_at: new Date(now + normaNotificationBackoffMs(attempts)).toISOString(),
      last_error: message.slice(0, 500),
      updated_at: new Date(now).toISOString(),
    })
    .eq("id", id);
  // The lease still holds the row back if this write fails.
  if (error) reportError(new Error(error.message), { tags: { surface: "norma_slack_notification_backoff" }, extra: { notificationId: id } });
}

async function buildMessage(client: Client, requestId: string, env?: NormaEnv): Promise<{ blocks: KnownBlock[]; text: string }> {
  const { data: request, error } = await client
    .from("norma_call_requests")
    .select("id, property_id, contact_id, outcome, summary, qualification, callback_raw")
    .eq("id", requestId)
    .maybeSingle();
  if (error || !request) throw new Error("norma notification: request not readable");

  const { data: property, error: propertyError } = await client
    .from("properties")
    .select("address, city, state")
    .eq("id", request.property_id)
    .maybeSingle();
  if (propertyError || !property) throw new Error("norma notification: property not readable");

  let sellerName: string | null = null;
  if (request.contact_id) {
    const { data: contact, error: contactError } = await client
      .from("contacts")
      .select("contact_type, first_name, last_name, entity_name")
      .eq("id", request.contact_id)
      .maybeSingle();
    if (contactError) throw new Error("norma notification: contact not readable");
    if (contact) {
      sellerName =
        contact.contact_type === "entity"
          ? contact.entity_name
          : [contact.first_name, contact.last_name].filter(Boolean).join(" ") || null;
    }
  }

  const qualification =
    request.qualification && typeof request.qualification === "object" && !Array.isArray(request.qualification)
      ? (request.qualification as Record<string, unknown>)
      : {};
  const followUp = typeof qualification.follow_up_preference === "string" ? qualification.follow_up_preference : null;
  const callbackPreference = request.callback_raw?.trim() || (request.outcome === "callback_requested" ? followUp : null);
  const propertyAddress = [property.address, property.city, property.state].filter(Boolean).join(", ");
  const input = {
    sellerName,
    propertyAddress,
    outcome: request.outcome,
    summary: request.summary,
    qualification,
    callbackPreference,
    deepLink: buildNormaLeadDeepLink(request.property_id, env),
  };
  return { blocks: buildNormaSummaryBlocks(input), text: buildNormaSummaryFallbackText(input) };
}
