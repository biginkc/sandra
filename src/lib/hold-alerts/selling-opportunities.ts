import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { hotTextKey, isHotReason, leadReplyKey } from "@/lib/hot-sellers/hot";
import { actionForNineAnswer, NINE_ANSWER_LABELS, NINE_QUESTION_CUTOFF, type NineAnswer } from "@/lib/sms-classification/nine-questions";
import type { HotPromotion } from "./types";
import { MAX_ATTEMPTS } from "./types";

const PAGE = 200;
const SETTLE_MS = 30 * 60 * 1000;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

type Decision = {
  engine?: unknown;
  answer?: unknown;
  sellingOpportunity?: { probability?: unknown };
};

export function isSupplementalOpportunity(decision: Decision | null): boolean {
  if (decision?.engine !== "nine_questions") return false;
  const p = decision.sellingOpportunity?.probability;
  if (typeof p !== "number" || !Number.isFinite(p) || p < NINE_QUESTION_CUTOFF || p > 1) return false;
  const answer = decision.answer;
  if (typeof answer !== "string" || !Object.hasOwn(NINE_ANSWER_LABELS, answer)) return false;
  // Hot classifications already have their own handoff/alert. This signal never promotes a property.
  return actionForNineAnswer(answer as NineAnswer).kind !== "hot";
}

/**
 * Classification rows are the durable source: no second write that could fail between
 * classification and dispatch. Read-only, including for stop/hostile messages. Shadow
 * and historical runs without the supplemental answer never produce alerts.
 */
export async function loadSellingOpportunities(
  db: LooseSupabase,
  orgId: string,
  alertsSince: string,
  nowMs: number,
  currentOwner: string | null,
): Promise<{ promotions: HotPromotion[]; complete: boolean }> {
  if (!currentOwner) return { promotions: [], complete: true };
  const since = new Date(Math.max(Date.parse(alertsSince) || 0, nowMs - LOOKBACK_MS)).toISOString();
  type Run = { id: string; property_id: string; source_inbound_message_id: string; created_at: string; decision: Decision | null };
  const candidates = new Map<string, Run>();
  let before: Run | null = null;
  for (;;) {
    let q = db.from("sms_classification_runs")
      .select("id, property_id, source_inbound_message_id, created_at, decision")
      .eq("org_id", orgId).eq("decision->>engine", "nine_questions")
      .gte("created_at", since);
    if (before) q = q.or(`created_at.lt.${before.created_at},and(created_at.eq.${before.created_at},id.lt.${before.id})`);
    const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE);
    if (error) return { promotions: [], complete: false };
    const page = (data ?? []) as Run[];
    for (const run of page) {
      // Newest classification of an inbound wins, even when it says no.
      if (run.source_inbound_message_id && !candidates.has(run.source_inbound_message_id)) candidates.set(run.source_inbound_message_id, run);
    }
    if (page.length < PAGE) break;
    before = page[page.length - 1]!;
  }
  const runs = [...candidates.values()].filter((r) => isSupplementalOpportunity(r.decision));
  const promotions: HotPromotion[] = [];
  let complete = true;
  for (let offset = 0; offset < runs.length; offset += PAGE) {
    const batch = runs.slice(offset, offset + PAGE);
    const inboundIds = batch.map((r) => r.source_inbound_message_id);
    const { data: messages, error: messageError } = await db.from("messages")
      .select("id, property_id, created_at").eq("org_id", orgId).eq("direction", "inbound")
      .eq("channel", "sms").in("id", inboundIds).gte("created_at", since);
    const { data: properties, error: propertyError } = await db.from("properties")
      .select("id, contacts:homeowner_contact_id(first_name)").eq("org_id", orgId)
      .in("id", batch.map((r) => r.property_id)).is("deleted_at", null);
    // Classification precedes routing. Wait for the route before deciding whether
    // a deterministic price hold already owns the alert for this inbound.
    const { data: pipeline, error: pipelineError } = await db.from("pipeline_runs")
      .select("inbound_message_id, property_id, final_outcome, reason")
      .eq("org_id", orgId).in("inbound_message_id", inboundIds);
    // A generic lead-reply alert that already owns this inbound must not be followed
    // by a second alert. Share hot_text's delivery identity for the same reason.
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
    for (const run of batch) {
      const id = run.source_inbound_message_id;
      const message = inbound.get(id);
      const property = props.get(run.property_id);
      const key = hotTextKey(id);
      if (!message || message.property_id !== run.property_id || !property || leadReplied.has(leadReplyKey(id))) continue;
      const routes = routed.filter((r) => r.inbound_message_id === id && r.property_id === run.property_id);
      if (routes.some((r) => isHotReason(r.reason))) continue;
      if (!routes.some((r) => r.final_outcome) && nowMs - Date.parse(message.created_at) < SETTLE_MS) continue;
      if (done.get(key)?.has("slack") && done.get(key)?.has("sms")) continue;
      promotions.push({ propertyId: run.property_id, assigneeUserId: currentOwner,
        name: property.contacts?.first_name?.trim() || "Unknown sender", assignedAt: message.created_at,
        kind: "selling_opportunity", inboundId: id, key });
    }
  }
  return { promotions, complete };
}
