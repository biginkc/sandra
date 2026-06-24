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

export type AiAction =
  | "send_reply"
  | "escalate"
  | "opt_out"
  | "close_wrong_number"
  | "close_dnc"
  | "close_not_interested"
  | "deescalate_close";

export type AiEscalationReason =
  | "hot_lead"
  | "price_or_offer"
  | "distress"
  | "multi_property"
  | "call_request"
  | "third_party"
  | "needs_review";

export type AiWrongScope = "this_property" | "all";

type AiStructuredBase = {
  /** 0-1 confidence that the chosen action is correct and safe. */
  confidence: number;
  sentiment: AiSentiment;
};

export type AiStructuredOutput =
  | (AiStructuredBase & {
      action: "send_reply";
      body: string;
      escalation_reason?: never;
      wrong_scope?: never;
    })
  | (AiStructuredBase & {
      action: "escalate";
      body?: never;
      escalation_reason: AiEscalationReason;
      wrong_scope?: never;
    })
  | (AiStructuredBase & {
      action: "opt_out";
      body?: never;
      escalation_reason?: never;
      wrong_scope?: never;
    })
  | (AiStructuredBase & {
      action: "close_wrong_number";
      body?: never;
      escalation_reason?: never;
      wrong_scope: AiWrongScope;
    })
  | (AiStructuredBase & {
      action: "close_dnc";
      body?: never;
      escalation_reason?: never;
      wrong_scope?: never;
    })
  | (AiStructuredBase & {
      action: "close_not_interested";
      body?: never;
      escalation_reason?: never;
      wrong_scope?: never;
    })
  | (AiStructuredBase & {
      action: "deescalate_close";
      body: string;
      escalation_reason?: never;
      wrong_scope?: never;
    });

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
