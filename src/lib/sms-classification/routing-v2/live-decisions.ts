import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import type { V2Classification } from "./classify";

type Decided = Extract<V2Classification, { kind: "decided" }>;
export type LiveDecisionContext = {
  orgId: string;
  propertyId: string;
  conversationId: string | null;
  inboundMessageId: string;
  expectedRevision: number;
};

/** Same Haiku evidence shape as the reviewed phone-action gate, without hiding Jev's
 * original provenance. No seller text or provider error body is persisted here. */
function haikuEvidence(result: Decided) {
  const h = result.haiku;
  const final = result.final;
  if (!final) return null;
  return {
    asked: h !== null,
    option: h?.ok ? h.option : null,
    confidence: h?.ok ? h.confidence : null,
    failure_reason: final.failureReason,
    final_road: final.road,
    final_by: final.by,
    hold: final.hold,
    alert: final.alert,
    latency_ms: h && "latencyMs" in h ? h.latencyMs : null,
    attempts: h && "attempts" in h ? h.attempts : null,
    input_tokens: h && "inputTokens" in h ? h.inputTokens : null,
    output_tokens: h && "outputTokens" in h ? h.outputTokens : null,
    cost_usd: h && "costUsd" in h ? h.costUsd : null,
  };
}

export function liveDecisionRow(context: LiveDecisionContext, result: Exclude<V2Classification, { kind: "off" }>) {
  if (!context.inboundMessageId || !Number.isSafeInteger(context.expectedRevision) || context.expectedRevision < 0) {
    throw new Error("routing_v2_live_evidence_context_invalid");
  }
  const base = {
    org_id: context.orgId, property_id: context.propertyId,
    conversation_id: context.conversationId, inbound_message_id: context.inboundMessageId,
    expected_revision: context.expectedRevision,
  };
  if (result.kind === "failed") return { ...base, status: "failed", failure_reason: result.reason };
  return {
    ...base, status: "decided", road: result.action.road, jev_road: result.decision.road,
    provenance: result.decision.provenance, haiku_eligibility: result.decision.haiku,
    haiku: haikuEvidence(result), opportunity_alert: result.decision.opportunityAlert,
    probabilities: result.probabilities, property_type: result.propertyType,
    action: result.action, price_outcome: result.priceOutcome,
    model: result.model, latency_ms: result.latencyMs,
  };
}

type Loose = { from: (table: string) => { insert: (row: unknown) => PromiseLike<{ error: { code?: string } | null }> } };

/** A duplicate never authorizes the caller's freshly computed action. Only the durable
 * original may be recovered; never overwrite evidence and execute a different retry. */
export async function recordLiveV2Decision(
  db: SupabaseClient<Database>,
  context: LiveDecisionContext,
  result: Exclude<V2Classification, { kind: "off" }>,
  /**
   * Astra review of b6a00a0a2f17 (A): a safety decision's hold reason. The decision row, the
   * safety hold, the pause of the lead's v2 drips and the cancel of its pending v2 replies then
   * commit in ONE transaction (routing_v2_record_live_decision), or nothing is recorded
   * ("hold_failed"). Without a reason the row is inserted as before.
   */
  safetyHoldReason?: string | null,
): Promise<"recorded" | "duplicate" | "failed" | "hold_failed"> {
  return recordLiveV2DecisionRow(db, liveDecisionRow(context, result), safetyHoldReason);
}

/**
 * Record an already-built decision row (the routing v2 backfill replays the row a classify-only
 * run built). Same contract as recordLiveV2Decision.
 */
export async function recordLiveV2DecisionRow(
  db: SupabaseClient<Database>,
  row: Record<string, unknown>,
  safetyHoldReason?: string | null,
): Promise<"recorded" | "duplicate" | "failed" | "hold_failed"> {
  if (safetyHoldReason) {
    try {
      const { data, error } = await (db as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
      }).rpc("routing_v2_record_live_decision", { p_row: row, p_hold_reason: safetyHoldReason });
      if (!error) return data === "duplicate" ? "duplicate" : data === "recorded" ? "recorded" : "failed";
      // A database without the recorder: the plain insert below (its effects then stay unrecorded,
      // so the apply gate and the sweep treat it as unrecovered until its hold lands).
      if (!/PGRST202|42883|does not exist|Could not find/i.test(error.message)) return "hold_failed";
    } catch (e) {
      // A client without rpc (test doubles) is treated like a database without the recorder.
      if (!(e instanceof TypeError)) return "hold_failed";
    }
  }
  try {
    const { error } = await (db as unknown as Loose).from("routing_v2_live_decisions").insert(row);
    if (!error) return "recorded";
    return error.code === "23505" ? "duplicate" : "failed";
  } catch {
    return "failed";
  }
}
