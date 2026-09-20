import type {
  AiAction,
  AiEscalationReason,
  AiWrongScope,
} from "../ai-responder/types";

/**
 * Jev outcome taxonomy, extended with the human-reviewed new-lead category.
 * Distinct from `AiAction`: no `body` (Jev never generates reply text),
 * `bad_number` and `unclear` are adapter-only values `AiAction` doesn't have.
 */
export type JevOutcome =
  | "new_lead"
  | "nurture"
  | "not_interested"
  | "wrong_number"
  | "bad_number"
  | "opted_out"
  | "dnc"
  | "unclear";

export type JevWrongScope = AiWrongScope | "not_applicable" | "uncertain";
export type JevEscalationReason =
  | AiEscalationReason
  | "not_applicable"
  | "uncertain";
export type JevReplyIntent = "positive" | "negative" | "neutral";

/** Validated, provider-independent classification result. */
export type SmsClassificationDecision = {
  outcome: JevOutcome;
  /** Native TypeSafe confidence; absent/invalid is unknown, never certainty. */
  outcomeConfidence?: number | null;
  wrongScope: JevWrongScope | null;
  escalationReason: JevEscalationReason | null;
  replyIntent: JevReplyIntent | null;
  replyIntentAvailable: boolean;
  /** Per-question probabilities as returned by the provider, keyed by question id. */
  probabilities: Record<string, Record<string, number>>;
  provider: "jev" | "legacy";
  model: string;
  schemaVersion: string;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  latencyMs: number;
};

/**
 * `outcome` values that map onto an existing `AiAction` / `ResponderRoute`
 * and therefore go through `resolveResponderOutcome`. `bad_number` and
 * `unclear` are excluded on purpose — never route them through it.
 *
 * `nurture` is deliberately NOT included here — it is not a conversational
 * action (no reply, no escalation, no close) and has no `AiAction`. It is
 * handled as its own effect in policy.ts: call the existing
 * `setOutreachDispo(propertyId, "nurture")` server action
 * (`src/app/(dashboard)/messages/dispo-actions.ts:105`) directly, label-only,
 * no owner assignment. Jarrad's ruling (2026-09-20): apply the label now;
 * `needs_sequence` (which requires a human `needs_sequence_owner_id` —
 * `src/lib/my-leads/settings.ts:150` — and has no automatic assignment path)
 * is the future migration target once real sequence hookup exists, not
 * something Jev decides. Do not write `needs_sequence` from this adapter.
 */
export const JEV_OUTCOME_TO_ACTION: Partial<Record<JevOutcome, AiAction>> = {
  not_interested: "close_not_interested",
  wrong_number: "close_wrong_number",
  opted_out: "opt_out",
  dnc: "close_dnc",
};
