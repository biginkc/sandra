/**
 * Classifies an outbound message that landed in a thread after the AI run's
 * observation window opened. The AI must not double-reply, but only some
 * outbounds mean "a human needs to look".
 *
 * Classes:
 *  - broadcast: drip/sequence tick, bulk campaign, Norma pre-call text, seller
 *    appointment reminder. It never answers the seller's inbound.
 *  - answered: a conversational outbound that already answers THIS inbound: an
 *    AI reply stamped with this inbound id, or a human/rep reply that is
 *    created at or after the inbound AND actually sent/delivered.
 *  - unsent_reply: a reply that has NOT left yet and so has not answered the
 *    seller (it can still fail or abort): a human/rep reply at/after the
 *    inbound that is only queued/pending, or an AI row for THIS inbound that is
 *    still `pending` (an in-flight or abandoned attempt).
 *  - unrelated_ai: an AI reply that is not for this inbound: stamped with a
 *    different inbound id, or with NO inbound id at all (never mistaken for a
 *    human reply).
 *  - unrelated_human: a human text that cannot be tied to this inbound (it
 *    predates it, or its timestamp cannot be compared).
 *
 * Precedence (`resolveOutboundVerdict`, the approved rule): already-answered
 * wins over everything (silent); else an AI reply to a different inbound or an
 * unrelated human text -> flag a human; else an unsent human reply -> wait for
 * it (retry, never a silent skip); else broadcast-only -> silent.
 */
export type OutboundRow = {
  id: string;
  created_at: string;
  status?: string | null;
  campaign_id?: string | null;
  metadata?: unknown;
};

export type OutboundClass =
  | "broadcast"
  | "answered"
  | "unsent_reply"
  | "unrelated_ai"
  | "unrelated_human";

export type OutboundVerdict =
  | "already_answered"
  | "outbound_since_claim"
  | "reply_pending"
  | "broadcast_since_claim";

const BROADCAST_GENERATORS = new Set(["norma_precall", "sequence_tick"]);
/** A human text only counts as having answered the seller once it really left. */
const HUMAN_FINAL_STATUSES = new Set(["sent", "delivered"]);

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
    // An AI row with no inbound id (or none known here) can never be proven to
    // answer THIS inbound, and it is not a human reply either.
    if (!ctx.inboundMessageId || meta.inbound_message_id !== ctx.inboundMessageId) {
      return "unrelated_ai";
    }
    return row.status === "pending" ? "unsent_reply" : "answered";
  }
  // Human / rep reply: answers this inbound only when created at or after it.
  const createdMs = Date.parse(row.created_at);
  if (Number.isNaN(createdMs) || ctx.inboundCreatedAtMs === null) return "unrelated_human";
  if (createdMs < ctx.inboundCreatedAtMs) return "unrelated_human";
  return HUMAN_FINAL_STATUSES.has(row.status ?? "") ? "answered" : "unsent_reply";
}

/** The single precedence rule over every class seen in the window. */
export function resolveOutboundVerdict(classes: readonly OutboundClass[]): OutboundVerdict {
  if (classes.includes("answered")) return "already_answered";
  if (classes.includes("unrelated_ai") || classes.includes("unrelated_human")) {
    return "outbound_since_claim";
  }
  if (classes.includes("unsent_reply")) return "reply_pending";
  return "broadcast_since_claim";
}
