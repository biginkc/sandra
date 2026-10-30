import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { hotTextKey, isHotReason, leadReplyKey } from "@/lib/hot-sellers/hot";
import { parseRoutingV2Flags, v2SliceAllowed } from "@/lib/sms-classification/routing-v2/flags";
import { DEFAULT_CUTOFF, OPPORTUNITY_SIGNALS } from "@/lib/sms-classification/routing-v2/order";

import type { HotPromotion } from "./types";
import { MAX_ATTEMPTS } from "./types";

/**
 * Routing v2 "possible selling opportunity" alert (PR-B). Port of PR #937's
 * `selling-opportunities.ts` delivery, reading the v2 decision (either approved
 * opportunity question ≥0.60) instead of #937's retired single question. Every #937 guard
 * is kept: non-hot only, newest decision per inbound wins, skip if a lead_reply alert owns
 * the inbound, shares the hotTextKey delivery identity, 30-min settle until routed, 7-day
 * lookback, owner-only, deleted properties excluded, price-hold routes skipped, read-only.
 *
 * Gated by `routing_v2_flags` (questions_live + replies + shadow + canary eligibility), read fresh
 * on every cron pass, so this is also the send-time check for the alert fan-out.
 * Flag off = returns nothing and makes no other query.
 */
const PAGE = 200;
const SETTLE_MS = 30 * 60 * 1000;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ALLOW-list of validated v2 roads that do not alert Jarrad on their own. Anything else
 * (ALERT_* roads, price_check, Haiku outcomes, null, an unknown or future road) gets no
 * opportunity alert: fail closed, one alert per reply.
 */
const NON_ALERTING_ROADS: ReadonlySet<string> = new Set([
  "stop",
  "wrong_number_close",
  "vacant_land_drip",
  "listed_drip",
  "text_only_reply",
  "how_it_works_reply",
  "maybe_later_drip",
  "not_interested_drip",
  "who_reply_drip",
  "which_property_reply",
  "location_reply",
  "confirmed_owner_drip",
  "bad_number",
]);

export type V2DecisionRow = {
  id: string;
  property_id: string;
  inbound_message_id: string | null;
  created_at: string;
  status: string;
  road: string | null;
  /** Persisted by PR-A's routeV2 (false for code pre-checks). Required true. */
  opportunity_alert: boolean | null;
  probabilities: Record<string, unknown> | null;
};

const validP = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Yes-family roads raise today's hot alert while alert_on_time_only is OFF (#937 non-hot guard). */
const HOT_YES_ROADS: ReadonlySet<string> = new Set(["book_appointment", "reaction+book_appointment", "driving_reply+book_appointment"]);

export function isV2Opportunity(
  row: Pick<V2DecisionRow, "status" | "road" | "probabilities" | "opportunity_alert"> | null,
  opts: { alertOnTimeOnly: boolean },
): boolean {
  if (!row || row.status !== "decided" || row.opportunity_alert !== true) return false;
  if (row.road === null) return false; // no Jev answer: the Haiku-unsure path alerts on its own
  const allowed = NON_ALERTING_ROADS.has(row.road) || (HOT_YES_ROADS.has(row.road) && opts.alertOnTimeOnly);
  if (!allowed) return false;
  const probs = row.probabilities;
  if (!probs || typeof probs !== "object") return false;
  return OPPORTUNITY_SIGNALS.some((q) => {
    const p = probs[q];
    return validP(p) && p >= DEFAULT_CUTOFF;
  });
}

/** Send-time re-check for one opportunity alert: fresh flags + eligibility. Any error = false. */
export async function v2OpportunityStillAllowed(db: LooseSupabase, orgId: string, propertyId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("ai_responder_configs")
      .select("routing_v2_flags")
      .eq("org_id", orgId)
      .eq("active", true)
      .maybeSingle();
    if (error) return false;
    const flags = parseRoutingV2Flags((data as { routing_v2_flags?: unknown } | null)?.routing_v2_flags);
    return flags.shadow && v2SliceAllowed(flags, "replies", propertyId);
  } catch {
    return false;
  }
}

export async function loadV2Opportunities(
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
  // The source table is only written while flags.shadow is on. The cutover PR must point this
  // at the live v2 decision log.
  if (!flags.questions_live || !flags.replies || !flags.shadow) return { promotions: [], complete: true };

  const since = new Date(Math.max(Date.parse(alertsSince) || 0, nowMs - LOOKBACK_MS)).toISOString();
  const candidates = new Map<string, V2DecisionRow>();
  let before: V2DecisionRow | null = null;
  for (;;) {
    let q = db
      .from("routing_v2_shadow_decisions")
      .select("id, property_id, inbound_message_id, created_at, status, road, opportunity_alert, probabilities")
      .eq("org_id", orgId)
      .gte("created_at", since);
    if (before) q = q.or(`created_at.lt.${before.created_at},and(created_at.eq.${before.created_at},id.lt.${before.id})`);
    const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE);
    if (error) return { promotions: [], complete: false };
    const page = (data ?? []) as V2DecisionRow[];
    for (const row of page) {
      // Newest decision of an inbound wins, even when it says no (or failed).
      if (row.inbound_message_id && !candidates.has(row.inbound_message_id)) candidates.set(row.inbound_message_id, row);
    }
    if (page.length < PAGE) break;
    before = page[page.length - 1]!;
  }
  const rows = [...candidates.values()].filter((r) => isV2Opportunity(r, { alertOnTimeOnly: flags.alert_on_time_only }) && v2SliceAllowed(flags, "replies", r.property_id));
  const promotions: HotPromotion[] = [];
  let complete = true;
  for (let offset = 0; offset < rows.length; offset += PAGE) {
    const batch = rows.slice(offset, offset + PAGE);
    const inboundIds = batch.map((r) => r.inbound_message_id!);
    const { data: messages, error: messageError } = await db.from("messages")
      .select("id, property_id, created_at").eq("org_id", orgId).eq("direction", "inbound")
      .eq("channel", "sms").in("id", inboundIds).gte("created_at", since);
    const { data: properties, error: propertyError } = await db.from("properties")
      .select("id, contacts:homeowner_contact_id(first_name)").eq("org_id", orgId)
      .in("id", batch.map((r) => r.property_id)).is("deleted_at", null);
    const { data: pipeline, error: pipelineError } = await db.from("pipeline_runs")
      .select("inbound_message_id, property_id, final_outcome, reason")
      .eq("org_id", orgId).in("inbound_message_id", inboundIds);
    const { data: deliveries, error: deliveryError } = await db.from("hold_alert_deliveries")
      .select("hold_key, channel, status, attempts").eq("org_id", orgId)
      .eq("recipient_user_id", currentOwner)
      .in("hold_key", inboundIds.flatMap((id) => [leadReplyKey(id), hotTextKey(id)]));
    if (messageError || propertyError || deliveryError || pipelineError) { complete = false; continue; }
    const inbound = new Map(((messages ?? []) as Array<{ id: string; property_id: string; created_at: string }>).map((m) => [m.id, m]));
    const props = new Map(((properties ?? []) as Array<{ id: string; contacts: { first_name: string | null } | null }>).map((p) => [p.id, p]));
    const routed = (pipeline ?? []) as Array<{ inbound_message_id: string; property_id: string | null; final_outcome: string | null; reason: string | null }>;
    const leadReplied = new Set<string>();
    const done = new Map<string, Set<string>>();
    for (const d of (deliveries ?? []) as Array<{ hold_key: string; channel: string; status: string; attempts: number }>) {
      if (d.hold_key.startsWith("lead_reply:") && (d.status === "pending" || d.status === "sending" || d.status === "sent" || (d.status === "failed" && d.attempts < MAX_ATTEMPTS))) leadReplied.add(d.hold_key);
      if (d.status === "sent" || d.status === "skipped" || (d.status === "failed" && d.attempts >= MAX_ATTEMPTS)) {
        const channels = done.get(d.hold_key) ?? new Set<string>();
        channels.add(d.channel); done.set(d.hold_key, channels);
      }
    }
    for (const row of batch) {
      const id = row.inbound_message_id!;
      const message = inbound.get(id);
      const property = props.get(row.property_id);
      const key = hotTextKey(id);
      if (!message || message.property_id !== row.property_id || !property || leadReplied.has(leadReplyKey(id))) continue;
      const routes = routed.filter((r) => r.inbound_message_id === id && r.property_id === row.property_id);
      if (routes.some((r) => isHotReason(r.reason))) continue;
      if (!routes.some((r) => r.final_outcome) && nowMs - Date.parse(message.created_at) < SETTLE_MS) continue;
      if (done.get(key)?.has("slack") && done.get(key)?.has("sms")) continue;
      promotions.push({ propertyId: row.property_id, assigneeUserId: currentOwner,
        name: property.contacts?.first_name?.trim() || "Unknown sender", assignedAt: message.created_at,
        kind: "selling_opportunity", inboundId: id, key });
    }
  }
  return { promotions, complete };
}
