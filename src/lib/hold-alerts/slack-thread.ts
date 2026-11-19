import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { reportError } from "@/lib/errors/report";

/**
 * Slack alert thread (Jarrad approved 2026-11-18): Slack alert DMs show the
 * recent text conversation with the seller under a linked headline. Slack only:
 * the SMS alert and the email digest never carry seller message text.
 */

export type ThreadMessage = { direction: "inbound" | "outbound"; body: string; createdAt: string };

/** The headline split around the linked part. Words are the existing alert copy, unchanged. */
export type SlackHeadline = { before: string; linkText: string; after: string; url: string };

export type ThreadLookup = { inboundId?: string | null; propertyId?: string | null };

export const THREAD_MAX_MESSAGES = 10;
export const THREAD_LOOKBACK_DAYS = 14;
export const THREAD_BODY_MAX_CHARS = 500;

/**
 * Only outbound rows that actually went out are part of the conversation. A
 * positive list, so queued/paused/scheduled/failed (and any status added later)
 * never show as something we said.
 */
const SENT_OUTBOUND = ["sent", "delivered"] as const;
const SENT_OUTBOUND_SET: ReadonlySet<string> = new Set(SENT_OUTBOUND);
const PHONE_RE = /^\+?\d{7,15}$/;

type Row = { direction: string; body: string | null; created_at: string; status: string | null; from_address?: string | null };

const COLUMNS = "direction, body, created_at, status";

/**
 * The last THREAD_MAX_MESSAGES SMS with this seller from the past
 * THREAD_LOOKBACK_DAYS days, newest first (Jarrad 2026-11-18). By the seller's phone (from the
 * alert's inbound message) when known, else by the property. Throws on a query
 * error; the caller fails open.
 */
export async function loadSlackThread(
  db: LooseSupabase,
  orgId: string,
  lookup: ThreadLookup,
  nowMs: number,
): Promise<ThreadMessage[]> {
  const sinceIso = new Date(nowMs - THREAD_LOOKBACK_DAYS * 86_400_000).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  const sent = `status.in.(${SENT_OUTBOUND.join(",")})`;
  let phone: string | null = null;
  if (lookup.inboundId) {
    const { data, error } = await db
      .from("messages")
      .select("from_address")
      .eq("org_id", orgId)
      .eq("id", lookup.inboundId)
      .eq("direction", "inbound")
      .maybeSingle();
    if (error) throw new Error(`thread inbound lookup failed: ${error.message}`);
    const from = (data as Row | null)?.from_address ?? null;
    if (from && PHONE_RE.test(from)) phone = from;
  }
  if (!phone && !lookup.propertyId) return [];
  let query = db
    .from("messages")
    .select(COLUMNS)
    .eq("org_id", orgId)
    .eq("channel", "sms")
    .gte("created_at", sinceIso)
    .lte("created_at", nowIso)
    .not("body", "is", null);
  // Eligibility (sent outbound only, real direction) is filtered in the query, before the
  // limit, so newer unsent rows can never crowd older real texts out of the last ten.
  query = phone
    ? query.or(`and(direction.eq.inbound,from_address.eq."${phone}"),and(direction.eq.outbound,to_address.eq."${phone}",${sent})`)
    : query.eq("property_id", lookup.propertyId).or(`direction.eq.inbound,and(direction.eq.outbound,${sent})`);
  // A little headroom for whitespace-only bodies, which the query can't exclude.
  const { data, error } = await query.order("created_at", { ascending: false }).limit(THREAD_MAX_MESSAGES * 2);
  if (error) throw new Error(`thread lookup failed: ${error.message}`);
  return toThread((data ?? []) as Row[], nowMs);
}

/** Rows (any order) → at most THREAD_MAX_MESSAGES real messages, newest first. */
export function toThread(rows: readonly Row[], nowMs: number): ThreadMessage[] {
  return rows
    .filter((r) => r.direction === "inbound" || r.direction === "outbound")
    .filter((r) => r.direction === "inbound" || SENT_OUTBOUND_SET.has(String(r.status ?? "").toLowerCase()))
    .filter((r) => Date.parse(r.created_at) <= nowMs)
    .filter((r) => (r.body ?? "").trim().length > 0)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, THREAD_MAX_MESSAGES)
    .map((r) => ({ direction: r.direction as ThreadMessage["direction"], body: r.body ?? "", createdAt: r.created_at }));
}

const CHICAGO = "America/Chicago";
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: CHICAGO, hour: "numeric", minute: "2-digit", hour12: true });
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: CHICAGO, month: "short", day: "numeric" });
const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: CHICAGO, year: "numeric", month: "2-digit", day: "2-digit" });

/** "8:44 pm" today in Chicago, else "Nov 12 8:44 pm". */
export function formatThreadTime(iso: string, nowMs: number): string {
  const d = new Date(iso);
  const time = timeFmt.format(d).replace(/\s*AM$/i, " am").replace(/\s*PM$/i, " pm");
  return keyFmt.format(d) === keyFmt.format(new Date(nowMs)) ? time : `${dayFmt.format(d)} ${time}`;
}

export function threadBody(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > THREAD_BODY_MAX_CHARS ? `${flat.slice(0, THREAD_BODY_MAX_CHARS)}…` : flat;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type SlackBlock = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * One rich_text block: the headline (its name/address part a link, no URL line),
 * then one section per message, labelled US or SELLER.
 * An empty thread yields just the linked headline.
 */
export function buildSlackAlertBlocks(headline: SlackHeadline, thread: readonly ThreadMessage[], nowMs: number): SlackBlock[] {
  const head: SlackBlock[] = [];
  if (headline.before) head.push({ type: "text", text: headline.before });
  head.push({ type: "link", url: headline.url, text: headline.linkText });
  if (headline.after) head.push({ type: "text", text: headline.after });
  return [{ type: "rich_text", elements: threadSections([{ type: "rich_text_section", elements: head }], thread, nowMs) }];
}

/**
 * The thread alone, for Slack DMs that already have their own headline blocks
 * (task assigned, appointment reminder, marked done). Empty thread → no block.
 */
export function buildSlackThreadBlocks(thread: readonly ThreadMessage[], nowMs: number): SlackBlock[] {
  if (thread.length === 0) return [];
  return [{ type: "rich_text", elements: threadSections([], thread, nowMs) }];
}

function threadSections(sections: SlackBlock[], thread: readonly ThreadMessage[], nowMs: number): SlackBlock[] {
  for (const m of thread.slice(0, THREAD_MAX_MESSAGES)) {
    const label = `${m.direction === "outbound" ? "US" : "SELLER"} ${formatThreadTime(m.createdAt, nowMs)}: `;
    const elements: SlackBlock[] = [];
    elements.push({ type: "text", text: `${label}${threadBody(m.body)}` });
    sections.push({ type: "rich_text_section", elements });
  }
  // A trailing newline per line keeps each message on its own row in every Slack client.
  for (const s of sections.slice(0, -1)) s.elements.push({ type: "text", text: "\n" });
  return sections;
}

/** One deadline for every Slack thread lookup. */
export const SLACK_THREAD_TIMEOUT_MS = 3_000;

/**
 * Runs a thread lookup with the shared deadline. Never throws: a missing
 * loader, an error or the deadline all yield [] (the message goes without a
 * thread). Every Slack sender calls this before its provider call.
 */
export async function loadThreadWithDeadline(
  load: (() => Promise<ThreadMessage[]> | undefined) | undefined,
  tags: Record<string, string>,
): Promise<ThreadMessage[]> {
  if (!load) return [];
  return (await withSlackDeadline(Promise.resolve().then(load), [], tags)) ?? [];
}

/**
 * Any Slack enrichment with the shared deadline. Never throws: an error or the
 * deadline yields `fallback`. Wrap the WHOLE enrichment (every query it makes),
 * so nothing can stall a send past SLACK_THREAD_TIMEOUT_MS.
 */
export async function withSlackDeadline<T>(work: Promise<T>, fallback: T, tags: Record<string, string>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), SLACK_THREAD_TIMEOUT_MS);
    });
    const result = await Promise.race([work, deadline]);
    if (result === TIMED_OUT) {
      reportError(new Error("Slack thread lookup timed out"), { tags });
      return fallback;
    }
    return result as T;
  } catch (error) {
    reportError(error, { tags });
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const TIMED_OUT: unique symbol = Symbol("slack_thread_timeout");

/**
 * Thread blocks for a lead-related Slack DM (by property). [] when there is no
 * property or nothing to show. Fail-open, bounded by SLACK_THREAD_TIMEOUT_MS.
 */
export async function loadLeadThreadBlocks(
  db: LooseSupabase,
  orgId: string | null | undefined,
  propertyId: string | null | undefined,
  surface: string,
  nowMs: number = Date.now(),
): Promise<SlackBlock[]> {
  if (!orgId || !propertyId) return [];
  const thread = await loadThreadWithDeadline(() => loadSlackThread(db, orgId, { propertyId }, nowMs), { surface });
  return buildSlackThreadBlocks(thread, nowMs);
}
