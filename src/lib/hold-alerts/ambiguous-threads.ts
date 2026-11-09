import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { ambiguousThreadKey } from "@/lib/hot-sellers/hot";

import { KEY_BATCH, LEAD_REPLY_LOOKBACK_MS } from "./lead-replies";
import type { HotPromotion } from "./types";
import { MAX_ATTEMPTS } from "./types";

const PAGE = 200;
const KEY_PREFIX = "ambiguous_thread:";

/**
 * Threading outcomes (messages.metadata.routing, written from thread.resolution in
 * messaging/inbound.ts) where a seller's reply could not be tied to one property.
 * Any of them may carry a single contact (thread link) or none (several contacts
 * share the phone: unknown-sender list). `unmatched_contact` (no contact at all)
 * and every matched_* outcome are deliberately excluded.
 */
export const AMBIGUOUS_THREAD_RESOLUTIONS: readonly string[] = ["ambiguous_recipient_number", "ambiguous_history", "ambiguous_contact"];

/** How far back unfinished ambiguous_thread:* delivery pairs are drained. */
export const AMBIGUOUS_DRAIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Opens the exact conversation, or the unknown-sender list when there is none. Never a contact id. */
export function ambiguousThreadLinkPath(conversationId: string | null): string {
  return conversationId ? `/messages?thread=${encodeURIComponent(conversationId)}` : "/messages?filter=unknown";
}

type Msg = {
  id: string;
  property_id: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  created_at: string;
  metadata: { routing?: unknown } | null;
};
const MSG_COLUMNS = "id, property_id, contact_id, conversation_id, created_at, metadata";

type DeliveryLite = { hold_key: string; channel: string; status: string; attempts: number; recipient_user_id: string };

const retryable = (d: DeliveryLite) => (d.status === "pending" || d.status === "failed") && d.attempts < MAX_ATTEMPTS;

/**
 * Alert-only loader for replies threading could not tie to one property.
 * Read-only: never guesses a property, never replays, never changes a message.
 *
 * Primary: inbound SMS with property_id null and an ambiguous threading outcome,
 * created at/after `since` and within the last hour.
 * Drain: ambiguous_thread:* delivery keys whose pair is unfinished: a pending or
 * retryable failed row, or (for the current owner) a channel row that was never
 * created. These come back with `drained: true` and no property, lookback or
 * watermark predicate, so a reply resolved or aged out mid-retry still finishes.
 */
export async function loadAmbiguousThreadAlerts(
  db: LooseSupabase,
  orgId: string,
  since: string,
  nowMs: number = Date.now(),
  currentOwner: string | null = null,
): Promise<{ promotions: HotPromotion[]; complete: boolean }> {
  let complete = true;
  const sinceIso = new Date(Math.max(Date.parse(since) || 0, nowMs - LEAD_REPLY_LOOKBACK_MS)).toISOString();

  const primary: Msg[] = [];
  let before: { at: string; id: string } | null = null;
  for (;;) {
    let q = db
      .from("messages")
      .select(MSG_COLUMNS)
      .eq("org_id", orgId)
      .eq("direction", "inbound")
      .eq("channel", "sms")
      .is("property_id", null)
      .in("metadata->>routing", [...AMBIGUOUS_THREAD_RESOLUTIONS])
      .gte("created_at", sinceIso);
    if (before) q = q.or(`created_at.lt.${before.at},and(created_at.eq.${before.at},id.lt.${before.id})`);
    const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE);
    if (error) {
      complete = false;
      break;
    }
    const page = (data ?? []) as Msg[];
    // Defensive re-check of the predicate in code.
    primary.push(...page.filter((m) => m.property_id === null && AMBIGUOUS_THREAD_RESOLUTIONS.includes(String(m.metadata?.routing ?? ""))));
    if (page.length < PAGE) break;
    const last = page[page.length - 1]!;
    before = { at: last.created_at, id: last.id };
  }

  // Drain: unfinished pairs on existing ambiguous_thread:* keys.
  const drainIds: string[] = [];
  const dl = await db
    .from("hold_alert_deliveries")
    .select("hold_key, channel, status, attempts, recipient_user_id")
    .eq("org_id", orgId)
    .like("hold_key", `${KEY_PREFIX}%`)
    .gte("created_at", new Date(nowMs - AMBIGUOUS_DRAIN_WINDOW_MS).toISOString());
  if (dl.error) {
    complete = false;
  } else {
    const byKey = new Map<string, DeliveryLite[]>();
    for (const d of (dl.data ?? []) as DeliveryLite[]) {
      if (!d.hold_key.startsWith(KEY_PREFIX) || d.hold_key.includes(":closed:")) continue;
      const list = byKey.get(d.hold_key) ?? [];
      list.push(d);
      byKey.set(d.hold_key, list);
    }
    for (const [key, rows] of byKey) {
      const mine = currentOwner ? rows.filter((r) => r.recipient_user_id === currentOwner) : rows;
      const channels = new Set(mine.map((r) => r.channel));
      // A channel row never created (run died between the two inserts) is unfinished too.
      const missingChannel = !!currentOwner && mine.length > 0 && !(channels.has("slack") && channels.has("sms"));
      if (mine.some(retryable) || missingChannel) drainIds.push(key.slice(KEY_PREFIX.length));
    }
  }
  const primaryIds = new Set(primary.map((m) => m.id));
  const toFetch = drainIds.filter((id) => !primaryIds.has(id));
  const drained: Msg[] = [];
  for (let i = 0; i < toFetch.length; i += KEY_BATCH) {
    const { data, error } = await db.from("messages").select(MSG_COLUMNS).eq("org_id", orgId).in("id", toFetch.slice(i, i + KEY_BATCH));
    if (error) {
      complete = false;
      continue;
    }
    drained.push(...((data ?? []) as Msg[]));
  }

  const all = [...primary.map((m) => ({ m, drained: false })), ...drained.map((m) => ({ m, drained: true }))];
  if (all.length === 0) return { promotions: [], complete };

  const contactIds = [...new Set(all.map((x) => x.m.contact_id).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const { data, error } = await db.from("contacts").select("id, first_name").eq("org_id", orgId).in("id", contactIds.slice(i, i + PAGE));
    // A failed name lookup only costs the name; the alert still goes with the fallback.
    if (error) continue;
    for (const c of (data ?? []) as Array<{ id: string; first_name: string | null }>) {
      const first = c.first_name?.trim();
      if (first) names.set(c.id, first);
    }
  }

  const promotions: HotPromotion[] = all.map(({ m, drained: isDrained }) => ({
    propertyId: null,
    assigneeUserId: "",
    name: (m.contact_id && names.get(m.contact_id)) || "Unknown sender",
    assignedAt: m.created_at,
    kind: "ambiguous_thread" as const,
    key: ambiguousThreadKey(m.id),
    inboundId: m.id,
    // Read at send time: after "Resolve to property" the link follows the restamped conversation.
    linkPath: ambiguousThreadLinkPath(m.conversation_id),
    ...(isDrained ? { drained: true } : {}),
  }));
  return { promotions, complete };
}
