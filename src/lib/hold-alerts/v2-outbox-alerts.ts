import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { V2_ALERT_LABELS, type V2AlertReason } from "@/lib/sms-classification/routing-v2/actions";
import { parseRoutingV2Flags } from "@/lib/sms-classification/routing-v2/flags";

import type { HotPromotion } from "./types";

/**
 * Routing v2 cutover: owner alerts queued in routing_v2_outbox (kind 'alert') are delivered
 * by this fan-out. Each channel send first passes routing_v2_alert_delivery_gate (claim ->
 * authorize -> provider-boundary check: fresh flags, slice, canary, alert_on_time_only),
 * so a stale yes alert never goes out once time-only alerts are on (N2). The delivery table
 * (hold_alert_deliveries, keyed by the alert's dedupe key) owns per-channel at-most-once and
 * retries. A newer seller reply never cancels an owner alert.
 *
 * Copy: the call-me / yes alerts reuse today's hot-text alert (same hotTextKey identity, so
 * they reconcile with today's classifier hot alert to one alert per inbound). Every other
 * reason reuses today's hold-alert copy with its approved v2 label (V2_ALERT_LABELS).
 * Flag off = returns nothing after one config read.
 */
const PAGE = 200;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const HOT_TEXT_REASONS: ReadonlySet<string> = new Set(["call_me", "hot_yes"]);

type OutboxAlertRow = {
  id: string;
  property_id: string;
  inbound_message_id: string;
  created_at: string;
  status: string;
  payload: { reason?: unknown; dedupe_key?: unknown } | null;
};

export async function loadV2OutboxAlerts(
  db: LooseSupabase,
  orgId: string,
  alertsSince: string,
  nowMs: number,
  currentOwner: string | null,
): Promise<{ promotions: HotPromotion[]; complete: boolean }> {
  if (!currentOwner) return { promotions: [], complete: true };
  const { data: cfg, error: cfgError } = await db
    .from("ai_responder_configs")
    .select("routing_v2_flags")
    .eq("org_id", orgId)
    .eq("active", true)
    .maybeSingle();
  if (cfgError) return { promotions: [], complete: true }; // fail closed = off
  const flags = parseRoutingV2Flags((cfg as { routing_v2_flags?: unknown } | null)?.routing_v2_flags);
  if (!flags.questions_live || !flags.replies) return { promotions: [], complete: true };

  const since = new Date(Math.max(Date.parse(alertsSince) || 0, nowMs - LOOKBACK_MS)).toISOString();
  // Keyset-paged over the whole window (newest first), like loadV2Opportunities: a busy week
  // (> PAGE alerts) never hides a new alert behind older, already-sent ones.
  const all: OutboxAlertRow[] = [];
  let before: OutboxAlertRow | null = null;
  for (;;) {
    let q = db
      .from("routing_v2_outbox")
      .select("id, property_id, inbound_message_id, created_at, status, payload")
      .eq("org_id", orgId)
      .eq("kind", "alert")
      .in("status", ["pending", "claimed", "sent"])
      .gte("created_at", since);
    if (before) q = q.or(`created_at.lt.${before.created_at},and(created_at.eq.${before.created_at},id.lt.${before.id})`);
    const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE);
    if (error) return { promotions: [], complete: false };
    const page = (data ?? []) as OutboxAlertRow[];
    all.push(...page);
    if (page.length < PAGE) break;
    before = page[page.length - 1]!;
  }
  const rows = all.filter(
    (r) => typeof r.payload?.reason === "string" && r.payload.reason in V2_ALERT_LABELS && typeof r.payload?.dedupe_key === "string",
  );
  if (rows.length === 0) return { promotions: [], complete: true };
  const propertyIds = [...new Set(rows.map((r) => r.property_id))];
  const props = new Map<string, { id: string; address: string | null; contacts: { first_name: string | null } | null }>();
  const inboundAt = new Map<string, string>();
  const inboundIds = [...new Set(rows.map((r) => r.inbound_message_id))];
  for (let i = 0; i < Math.max(propertyIds.length, inboundIds.length); i += PAGE) {
    const pIds = propertyIds.slice(i, i + PAGE);
    const mIds = inboundIds.slice(i, i + PAGE);
    if (pIds.length) {
      const { data, error } = await db.from("properties")
        .select("id, address, contacts:homeowner_contact_id(first_name)").eq("org_id", orgId)
        .in("id", pIds).is("deleted_at", null);
      if (error) return { promotions: [], complete: false };
      for (const p of (data ?? []) as Array<{ id: string; address: string | null; contacts: { first_name: string | null } | null }>) props.set(p.id, p);
    }
    if (mIds.length) {
      const { data, error } = await db.from("messages").select("id, created_at").eq("org_id", orgId).in("id", mIds);
      if (error) return { promotions: [], complete: false };
      for (const m of (data ?? []) as Array<{ id: string; created_at: string }>) inboundAt.set(m.id, m.created_at);
    }
  }
  const promotions: HotPromotion[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const property = props.get(r.property_id);
    const at = inboundAt.get(r.inbound_message_id);
    const key = r.payload!.dedupe_key as string;
    if (!property || !at || seen.has(key)) continue;
    seen.add(key);
    const reason = r.payload!.reason as V2AlertReason;
    const name = property.contacts?.first_name?.trim() || "Unknown sender";
    promotions.push(HOT_TEXT_REASONS.has(reason)
      ? { propertyId: r.property_id, assigneeUserId: currentOwner, name, assignedAt: at, kind: "hot_text", inboundId: r.inbound_message_id, address: property.address ?? null, key, outboxId: r.id }
      : { propertyId: r.property_id, assigneeUserId: currentOwner, name, assignedAt: at, kind: "routing_v2_alert", inboundId: r.inbound_message_id, label: V2_ALERT_LABELS[reason], key, outboxId: r.id });
  }
  return { promotions, complete: true };
}

/** Send-time gate for one channel of an outbox alert. Anything but "ok" = not sent. */
export async function v2OutboxAlertGate(db: LooseSupabase, outboxId: string, key: string): Promise<string> {
  try {
    const { data, error } = await (db as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
    }).rpc("routing_v2_alert_delivery_gate", { p_outbox_id: outboxId, p_receipt: key });
    if (error) return "gate_error";
    return typeof data === "string" ? data : "gate_error";
  } catch {
    return "gate_error";
  }
}
