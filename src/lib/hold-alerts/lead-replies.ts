import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { HOT_FAILED_SOURCE_TYPE, HOT_HANDOFF_SOURCE_TYPE, HOT_TEXT_SOURCE_TYPE } from "@/lib/hot-sellers/assign";
import { LEAD_REPLY_ALERTS_START_ISO, hotFailedKey, hotHandoffKey, hotTextKey, leadReplyKey } from "@/lib/hot-sellers/hot";

import type { HotPromotion } from "./types";
import { MAX_ATTEMPTS } from "./types";

const PAGE = 200;
export const LEAD_REPLY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Owner decision 2026-10-20 ("Should every new text from a seller already on
 * your My Leads alert you?" → "Yes absolutely"): every inbound SMS on a lead
 * alerts Jarrad once, keyed lead_reply:<inbound>, whoever the lead is assigned to.
 * A lead = status past prospect, or a hot_seller_handoff / hot_seller_text event.
 * STOP texts included. A text that already got (or is getting) its own hot alert
 * on the same inbound is left to that alert. Read-only: never changes the lead.
 */
export async function loadLeadReplies(
  db: LooseSupabase,
  orgId: string,
  alertsSince: string,
  nowMs: number = Date.now(),
  currentOwner: string | null = null,
): Promise<{ promotions: HotPromotion[]; complete: boolean }> {
  const sinceMs = Math.max(Date.parse(alertsSince) || 0, Date.parse(LEAD_REPLY_ALERTS_START_ISO), nowMs - LEAD_REPLY_LOOKBACK_MS);
  const since = new Date(sinceMs).toISOString();
  type Msg = { id: string; property_id: string | null; created_at: string };
  const msgs: Msg[] = [];
  let complete = true;
  let before: { at: string; id: string } | null = null;
  for (;;) {
    let q = db
      .from("messages")
      .select("id, property_id, created_at")
      .eq("org_id", orgId)
      .eq("direction", "inbound")
      .eq("channel", "sms")
      .gte("created_at", since);
    if (before) q = q.or(`created_at.lt.${before.at},and(created_at.eq.${before.at},id.lt.${before.id})`);
    const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE);
    if (error) return { promotions: [], complete: false };
    const page = (data ?? []) as Msg[];
    msgs.push(...page);
    if (page.length < PAGE) break;
    const last = page[page.length - 1]!;
    before = { at: last.created_at, id: last.id };
  }
  const withProp = msgs.filter((m): m is Msg & { property_id: string } => !!m.property_id);
  if (withProp.length === 0) return { promotions: [], complete };

  // Which properties are leads, plus name/address for the alert.
  const propIds = [...new Set(withProp.map((m) => m.property_id))];
  const isLead = new Set<string>();
  const known = new Set<string>();
  const names = new Map<string, string>();
  const addresses = new Map<string, string>();
  for (let i = 0; i < propIds.length; i += PAGE) {
    const { data, error } = await db
      .from("properties")
      .select("id, status, address, city, contacts:homeowner_contact_id(first_name)")
      .eq("org_id", orgId)
      .in("id", propIds.slice(i, i + PAGE));
    if (error) {
      complete = false;
      continue;
    }
    for (const p of (data ?? []) as Array<{ id: string; status: string | null; address: string | null; city: string | null; contacts: { first_name: string | null } | null }>) {
      known.add(p.id);
      if (p.status && p.status !== "prospect") isLead.add(p.id);
      const first = p.contacts?.first_name?.trim();
      if (first) names.set(p.id, first);
      const addr = [p.address?.trim(), p.city?.trim()].filter(Boolean).join(", ");
      if (addr) addresses.set(p.id, addr);
    }
  }
  const unsure = propIds.filter((id) => known.has(id) && !isLead.has(id));
  for (let i = 0; i < unsure.length; i += PAGE) {
    const { data, error } = await db
      .from("lead_events")
      .select("property_id")
      .eq("org_id", orgId)
      .in("source_type", [HOT_HANDOFF_SOURCE_TYPE, HOT_TEXT_SOURCE_TYPE])
      .in("property_id", unsure.slice(i, i + PAGE));
    if (error) {
      complete = false;
      continue;
    }
    for (const r of (data ?? []) as Array<{ property_id: string }>) isLead.add(r.property_id);
  }
  const leadMsgs = withProp.filter((m) => isLead.has(m.property_id));
  if (leadMsgs.length === 0) return { promotions: [], complete };

  // Skip a text that has its own hot alert: an uncovered hot event on it, or any
  // hot delivery row for it. An unanswerable check skips (retried next pass): never two alerts.
  const skip = new Set<string>();
  const done = new Set<string>();
  const ids = leadMsgs.map((m) => m.id);
  for (let i = 0; i < ids.length; i += PAGE) {
    const batch = ids.slice(i, i + PAGE);
    const ev = await db
      .from("lead_events")
      .select("source_id, payload")
      .eq("org_id", orgId)
      .in("source_type", [HOT_HANDOFF_SOURCE_TYPE, HOT_TEXT_SOURCE_TYPE, HOT_FAILED_SOURCE_TYPE])
      .in("source_id", batch);
    const keys = batch.flatMap((id) => [hotTextKey(id), hotHandoffKey(id), hotFailedKey(id), leadReplyKey(id)]);
    const dl = await db
      .from("hold_alert_deliveries")
      .select("hold_key, channel, status, attempts, recipient_user_id")
      .eq("org_id", orgId)
      .in("hold_key", keys);
    if (ev.error || dl.error) {
      complete = false;
      for (const id of batch) skip.add(id);
      continue;
    }
    for (const r of (ev.data ?? []) as Array<{ source_id: string; payload: { covered_by_hold?: unknown } | null }>) {
      if (r.payload?.covered_by_hold !== true) skip.add(r.source_id);
    }
    const finished = new Map<string, Set<string>>();
    for (const d of (dl.data ?? []) as Array<{ hold_key: string; channel: string; status: string; attempts: number; recipient_user_id: string }>) {
      const sep = d.hold_key.indexOf(":");
      const prefix = d.hold_key.slice(0, sep);
      const id = d.hold_key.slice(sep + 1);
      if (prefix !== "lead_reply") {
        skip.add(id);
        continue;
      }
      if (currentOwner && d.recipient_user_id !== currentOwner) continue;
      if (!(d.status === "sent" || d.status === "skipped" || (d.status === "failed" && d.attempts >= MAX_ATTEMPTS))) continue;
      const set = finished.get(id) ?? new Set<string>();
      set.add(d.channel);
      finished.set(id, set);
    }
    for (const [id, set] of finished) if (set.has("slack") && set.has("sms")) done.add(id);
  }
  const promotions: HotPromotion[] = leadMsgs
    .filter((m) => !skip.has(m.id) && !done.has(m.id))
    .map((m) => ({
      propertyId: m.property_id,
      assigneeUserId: "",
      name: names.get(m.property_id) ?? "Unknown sender",
      assignedAt: m.created_at,
      kind: "lead_reply" as const,
      address: addresses.get(m.property_id) ?? null,
      key: leadReplyKey(m.id),
      inboundId: m.id,
    }));
  return { promotions, complete };
}
