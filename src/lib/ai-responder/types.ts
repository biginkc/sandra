/**
 * Shared types for the AI SMS auto-responder (Feature 6).
 *
 * Covers:
 *   · Escalation keyword tiers + the classifier's verdict shape
 *   · Skip decisions from the pre-call gate
 *   · Structured output returned by Claude (what we ask it for in its
 *     system prompt)
 *   · Metadata we stamp on `messages.metadata` for each AI-generated send
 */

// ---------- keyword classifier ----------------------------------------------

export type EscalationTier =
  | "handoff_request"
  | "price_offer"
  | "legal_contract"
  | "distressed_seller";

export type KeywordMatch = {
  tier: EscalationTier;
  /** The raw phrase that matched, for logging + debugging. */
  phrase: string;
};

// ---------- skip classifier --------------------------------------------------

export type SkipReason =
  | "no_consent"
  | "disabled_per_property"
  | "outside_business_hours"
  | "max_turns_reached"
  | "no_config"
  | "disabled_org_wide";

export type SkipDecision =
  | { skip: false }
  | { skip: true; reason: SkipReason };

// ---------- Claude structured output ---------------------------------------

export type AiSentiment = "positive" | "neutral" | "frustrated" | "hostile";

export type AiAction = "send_reply" | "escalate";

export type AiStructuredOutput = {
  action: AiAction;
  /** Required when action="send_reply"; unused when action="escalate". */
  body?: string;
  /** 0-1 confidence that the reply is on-topic + safe. Below the
   *  configured `min_confidence` → auto-escalate. */
  confidence: number;
  sentiment: AiSentiment;
  /** Required when action="escalate". */
  escalation_reason?: string;
};

// ---------- persistence ------------------------------------------------------

/** Payload written to `messages.metadata` for every AI-generated send. */
export type AiMessageMetadata = {
  generated_by: "ai_responder_v1";
  inbound_message_id?: string;
  model: string;
  confidence: number;
  sentiment: AiSentiment;
  /** 1-based turn number within this thread. */
  turn: number;
};
