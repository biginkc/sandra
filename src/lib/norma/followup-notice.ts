import type { SupabaseClient } from "@supabase/supabase-js";
import type { KnownBlock } from "@slack/types";

import { reportError } from "@/lib/errors/report";

import type { NormaEnv } from "./config";
import { buildNormaLeadDeepLink, escapeSlackText } from "./slack-blocks";
import {
  NORMA_NOTIFICATION_LEASE_MS,
  NORMA_NOTIFICATION_MAX_ATTEMPTS,
  NORMA_NOTIFICATION_ROW_RESERVE_MS,
  NORMA_NOTIFICATION_RUN_BUDGET_MS,
  normaNotificationBackoffMs,
  type NormaSlackPost,
} from "./slack-worker";

/**
 * Slack notice for Norma follow-up reassignments (plan rule 6 / B11).
 *
 * When completing or escalating a call hits a membership rejection (42501 FORBIDDEN), the queue schema
 * (20261009010100) still commits the call result and stores the task it could not create as a row in
 * `norma_followup_reassignments`. Nothing told anyone. This worker posts ONE Slack notice per row and per kind, through
 * the same poster and bot as the call summaries.
 *
 * It is a runtime prerequisite: it ships and runs BEFORE that table exists.
 *   - Table absent (42P01 from Postgres, PGRST205 from PostgREST's schema cache): a silent no-op.
 *   - It writes only inside the reassignment row's `payload.slack_notice` and never touches a call, task, drip or
 *     notification row, so a Slack failure cannot change a call outcome.
 *
 * No new table (the frozen SQL is not touched): the notice state lives in `payload.slack_notice` of the row itself.
 *   { state: "leased" | "pending" | "sent" | "gave_up", lease_token, lease_until, attempts, next_attempt_at,
 *     slack_ts, last_error }
 * Idempotency: `sent` is durable and is never posted again. Concurrency: every state change is a compare-and-swap
 * on (id, status = open, kind, payload.slack_notice.lease_token), so two overlapping sweeps cannot both post a row.
 * `kind` is part of the swap on purpose: the SQL upgrades a `review_task` row to `callback_task` in place and replaces
 * the whole payload (dropping `slack_notice`), which gives the superseding callback its own fresh notice, while a stale
 * writer holding the old kind can no longer write over the new payload.
 * Delivery is at-least-once like the call-summary outbox (a run that dies between the post and the sent-write posts
 * again after the lease expires); a duplicate heads-up is cheaper than a lost one.
 */
const TABLE = "norma_followup_reassignments";
const KEY = "slack_notice";
const BATCH = 10;
const ABSENT_CODES = new Set(["42P01", "PGRST205"]);

export type NormaFollowupKind = "callback_task" | "review_task";
type NoticeState = "leased" | "pending" | "sent" | "gave_up";
type Notice = {
  state: NoticeState;
  lease_token: string;
  lease_until?: string;
  attempts: number;
  next_attempt_at?: string;
  slack_ts?: string | null;
  last_error?: string | null;
};
type Row = {
  id: string;
  org_id: string;
  request_id: string;
  property_id: string;
  kind: NormaFollowupKind;
  payload: Record<string, unknown> | null;
  status: string;
  created_at: string;
};

export type NormaFollowupNoticeSummary = {
  configured: boolean;
  /** The reassignment table does not exist yet (stage 2 not applied): nothing to do. */
  tableAbsent: boolean;
  scanned: number;
  sent: number;
  failed: number;
  gaveUp: number;
  /** Another sweep got the row first, or its notice changed under us. */
  skipped: number;
  /** Posted, but the sent-write failed or lost the swap: not re-posted before the lease expires. */
  unrecorded: number;
  deferred: number;
};

export type NormaFollowupNoticeDeps = {
  client: SupabaseClient;
  /** Null when the Slack env is unset: rows are left exactly as they are. */
  post: NormaSlackPost | null;
  now?: number;
  env?: NormaEnv;
  clock?: () => number;
  budgetMs?: number;
  newToken?: () => string;
};

const readNotice = (payload: Record<string, unknown> | null): Notice | null => {
  const raw = payload?.[KEY];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Notice) : null;
};

function isDue(notice: Notice | null, now: number): boolean {
  if (!notice) return true;
  if (notice.state === "sent" || notice.state === "gave_up") return false;
  const at = Date.parse(notice.state === "leased" ? (notice.lease_until ?? "") : (notice.next_attempt_at ?? ""));
  return !Number.isFinite(at) || at <= now;
}

const isAbsent = (error: { code?: string } | null) => !!error?.code && ABSENT_CODES.has(error.code);

export async function drainNormaFollowupNotices(deps: NormaFollowupNoticeDeps): Promise<NormaFollowupNoticeSummary> {
  const summary: NormaFollowupNoticeSummary = { configured: deps.post !== null, tableAbsent: false, scanned: 0, sent: 0, failed: 0, gaveUp: 0, skipped: 0, unrecorded: 0, deferred: 0 };
  if (!deps.post) return summary;
  const now = deps.now ?? Date.now();
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const budgetMs = deps.budgetMs ?? NORMA_NOTIFICATION_RUN_BUDGET_MS;
  const newToken = deps.newToken ?? (() => crypto.randomUUID());

  // Eligibility is decided IN the query, before any limit, so announced (or backing-off) rows can never crowd out a due one:
  // never noticed, or a retry whose time has come, or a lease that expired. Oldest first within each. (ISO timestamps written by
  // this worker compare correctly as text.)
  const nowIso = new Date(now).toISOString();
  const base = () =>
    deps.client
      .from(TABLE)
      .select("id, org_id, request_id, property_id, kind, payload, status, created_at")
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .limit(BATCH);
  const results = await Promise.all([
    base().is(`payload->${KEY}`, null),
    base().eq(`payload->${KEY}->>state`, "pending").lte(`payload->${KEY}->>next_attempt_at`, nowIso),
    base().eq(`payload->${KEY}->>state`, "leased").lte(`payload->${KEY}->>lease_until`, nowIso),
  ]);
  const byId = new Map<string, Row>();
  for (const { data, error } of results) {
    if (error) {
      if (isAbsent(error)) {
        summary.tableAbsent = true;
        return summary;
      }
      throw new Error(`norma followup notice scan failed: ${error.message}`);
    }
    for (const row of (data ?? []) as Row[]) byId.set(row.id, row);
  }
  const due = [...byId.values()]
    .filter((row) => (row.kind === "callback_task" || row.kind === "review_task") && isDue(readNotice(row.payload), now))
    .sort((x, y) => x.created_at.localeCompare(y.created_at))
    .slice(0, BATCH);

  for (const [index, row] of due.entries()) {
    if (clock() - startedAt > budgetMs - NORMA_NOTIFICATION_ROW_RESERVE_MS) {
      summary.deferred = due.length - index;
      break;
    }
    summary.scanned += 1;
    const previous = readNotice(row.payload);
    // The attempt is counted when the lease is taken, so a run that dies, or whose backoff write fails, still spends it.
    const attempts = (previous?.attempts ?? 0) + 1;
    const token = newToken();
    const giveUpNow = attempts > NORMA_NOTIFICATION_MAX_ATTEMPTS;
    const leased: Notice = giveUpNow
      ? { state: "gave_up", lease_token: token, attempts: attempts - 1, last_error: previous?.last_error ?? "lease expired repeatedly" }
      : { state: "leased", lease_token: token, lease_until: new Date(now + NORMA_NOTIFICATION_LEASE_MS).toISOString(), attempts };
    try {
      if (!(await swap(deps.client, row, previous, leased))) {
        summary.skipped += 1;
        continue;
      }
    } catch (leaseError) {
      // One row's failed lease write must not abort the batch.
      reportError(leaseError, { tags: { surface: "norma_followup_notice_lease" }, extra: { reassignmentId: row.id } });
      summary.skipped += 1;
      continue;
    }
    if (giveUpNow) {
      reportError(new Error("norma followup notice gave up after repeated expired leases"), { tags: { surface: "norma_followup_notice" }, extra: { reassignmentId: row.id } });
      summary.gaveUp += 1;
      continue;
    }

    let ts: string;
    try {
      const message = await buildFollowupMessage(deps.client, row, deps.env);
      ({ ts } = await deps.post(message));
    } catch (failure) {
      const giveUp = attempts >= NORMA_NOTIFICATION_MAX_ATTEMPTS;
      reportError(failure, { tags: { surface: "norma_followup_notice" }, extra: { reassignmentId: row.id, attempts } });
      const next: Notice = {
        state: giveUp ? "gave_up" : "pending",
        lease_token: token,
        attempts,
        next_attempt_at: new Date(now + normaNotificationBackoffMs(attempts)).toISOString(),
        last_error: (failure instanceof Error ? failure.message : "unknown_error").slice(0, 500),
      };
      // The lease still holds the row back if this write fails.
      await swap(deps.client, row, leased, next).catch((e) => reportError(e, { tags: { surface: "norma_followup_notice_backoff" }, extra: { reassignmentId: row.id } }));
      if (giveUp) summary.gaveUp += 1;
      else summary.failed += 1;
      continue;
    }

    // Slack has the message: a bookkeeping error must never back the row off into a re-post.
    try {
      const recorded = await recordSent(deps.client, row, leased, { state: "sent", lease_token: token, attempts, slack_ts: ts, last_error: null });
      if (recorded) summary.sent += 1;
      else {
        // The row changed under us (e.g. a callback superseded a review task): its new payload gets its own notice.
        summary.unrecorded += 1;
      }
    } catch (bookkeeping) {
      summary.unrecorded += 1;
      reportError(bookkeeping, { tags: { surface: "norma_followup_notice_sent_write" }, extra: { reassignmentId: row.id, slackTs: ts } });
    }
  }
  return summary;
}

/**
 * Compare-and-swap of `payload.slack_notice`. The filter pins the row's status, its kind and the exact notice we
 * read (absent, or the lease token we saw), so any concurrent writer, sweep or supersede makes it match nothing.
 */
async function swap(client: SupabaseClient, row: Row, expected: Notice | null, next: Notice): Promise<boolean> {
  let query = client
    .from(TABLE)
    .update({ payload: { ...(row.payload ?? {}), [KEY]: next } })
    .eq("id", row.id)
    .eq("status", "open")
    .eq("kind", row.kind);
  query = expected ? query.eq(`payload->${KEY}->>lease_token`, expected.lease_token) : query.is(`payload->${KEY}`, null);
  const { data, error } = await query.select("id");
  if (error) throw new Error(`norma followup notice write failed: ${error.message}`);
  return (data?.length ?? 0) === 1;
}

async function recordSent(client: SupabaseClient, row: Row, expected: Notice, next: Notice): Promise<boolean> {
  // The post already succeeded: retry the bookkeeping once rather than risk a repeat post.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await swap(client, row, expected, next);
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

/** Neutral, factual text in the call-summary style: stored data only, no authored script. */
export function buildNormaFollowupBlocks(input: { kind: NormaFollowupKind; sellerName: string | null; propertyAddress: string; title: string | null; deepLink: string }): { blocks: KnownBlock[]; text: string } {
  const callback = input.kind === "callback_task";
  const header = callback ? "Norma callback task needs a new owner" : "Norma review task needs a new owner";
  const detail = callback
    ? "The callback task for this Norma call was not created because the person it was assigned to can no longer take it."
    : "Sandra could not confirm the result of this Norma call, and the review task was not created because the person it was assigned to can no longer take it. Check Bland and the lead before calling again.";
  const blocks: KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: header, emoji: false } },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Seller:* ${escapeSlackText(input.sellerName?.trim() || "Unknown")}\n*Property:* ${escapeSlackText(input.propertyAddress)}` },
    },
    { type: "section", text: { type: "mrkdwn", text: detail } },
  ];
  if (input.title?.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Task:* ${escapeSlackText(input.title.trim())}` } });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${input.deepLink}|Open lead in Sandra>` }] });
  return { blocks, text: `${header} (${escapeSlackText(input.propertyAddress)})` };
}

async function buildFollowupMessage(client: SupabaseClient, row: Row, env?: NormaEnv): Promise<{ blocks: KnownBlock[]; text: string }> {
  // Org scoping: the property must belong to the row's own org.
  const { data: property, error } = await client
    .from("properties")
    .select("address, city, state, homeowner_contact_id")
    .eq("id", row.property_id)
    .eq("org_id", row.org_id)
    .maybeSingle();
  if (error || !property) throw new Error("norma followup notice: property not readable in the row's org");

  let sellerName: string | null = null;
  if (property.homeowner_contact_id) {
    const { data: contact, error: contactError } = await client
      .from("contacts")
      .select("contact_type, first_name, last_name, entity_name")
      .eq("id", property.homeowner_contact_id)
      .eq("org_id", row.org_id)
      .maybeSingle();
    if (contactError) throw new Error("norma followup notice: contact not readable");
    if (contact) {
      sellerName = contact.contact_type === "entity" ? contact.entity_name : [contact.first_name, contact.last_name].filter(Boolean).join(" ") || null;
    }
  }
  const title = typeof row.payload?.title === "string" ? row.payload.title : null;
  return buildNormaFollowupBlocks({
    kind: row.kind,
    sellerName,
    propertyAddress: [property.address, property.city, property.state].filter(Boolean).join(", "),
    title,
    deepLink: buildNormaLeadDeepLink(row.property_id, env),
  });
}
