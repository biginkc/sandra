/**
 * Classifies an outbound message that landed in a thread after the AI run took
 * its claim. The AI must not double-reply, but only some outbounds mean "a
 * human needs to look":
 *
 *  - broadcast: drip/sequence tick, bulk campaign, Norma pre-call text, seller
 *    appointment reminder. It never answers the seller's inbound. The AI reply
 *    is skipped silently (step `superseded_by_broadcast`).
 *  - answered: a conversational outbound that already answers THIS inbound: an
 *    AI reply stamped with this inbound id, or a human/rep reply created at or
 *    after the inbound. Skip silently (step `already_answered`).
 *  - unrelated: conversational but not an answer to this inbound (an AI reply
 *    to a different inbound, or a human text that predates the inbound). The
 *    seller is genuinely unresolved, so the property is flagged.
 */
export type OutboundRow = {
  id: string;
  created_at: string;
  campaign_id?: string | null;
  metadata?: unknown;
};

export type OutboundClass = "broadcast" | "answered" | "unrelated";

const BROADCAST_GENERATORS = new Set(["norma_precall", "sequence_tick"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Row ids that are linked to a sequence step run (caller looks these up). */
export function classifyOutbound(
  row: OutboundRow,
  ctx: { inboundMessageId: string | null; inboundCreatedAtMs: number | null; sequenceMessageIds?: ReadonlySet<string> },
): OutboundClass {
  const meta = record(row.metadata);
  if (row.campaign_id) return "broadcast";
  if (typeof meta?.generated_by === "string" && BROADCAST_GENERATORS.has(meta.generated_by)) {
    return "broadcast";
  }
  if (meta?.kind === "seller_appointment_reminder") return "broadcast";
  if (ctx.sequenceMessageIds?.has(row.id)) return "broadcast";

  if (meta?.generated_by === "ai_responder_v1") {
    return ctx.inboundMessageId && meta.inbound_message_id === ctx.inboundMessageId
      ? "answered"
      : "unrelated";
  }
  // Human / rep reply: answers this inbound when created at or after it.
  const createdMs = Date.parse(row.created_at);
  if (Number.isNaN(createdMs) || ctx.inboundCreatedAtMs === null) return "unrelated";
  return createdMs >= ctx.inboundCreatedAtMs ? "answered" : "unrelated";
}
