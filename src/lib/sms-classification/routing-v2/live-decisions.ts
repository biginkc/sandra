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
): Promise<"recorded" | "duplicate" | "failed"> {
  try {
    const { error } = await (db as unknown as Loose).from("routing_v2_live_decisions").insert(liveDecisionRow(context, result));
    if (!error) return "recorded";
    return error.code === "23505" ? "duplicate" : "failed";
  } catch {
    return "failed";
  }
}
