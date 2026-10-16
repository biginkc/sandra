/**
 * Luna prompt, assembled ONLY from (a) text copied by reference from the Jev
 * definitions in ../questions.ts (never retyped) and (b) the six framing
 * sentences in LUNA_FRAMING below.
 *
 * Governance: no LLM may add, edit, merge, replace or remove a business rule
 * unless a human approved that exact text. The outcome and escalation
 * definitions are Jev's own, verbatim. The six framing sentences are NOT
 * business rules but they ARE words an LLM wrote, so they are held in one
 * constant and listed in the PR body for approval.
 */
import { buildQuestions, OUTCOME_CRITERIA } from "../questions";
import type { JevOutcome } from "../types";

// Approved verbatim by Jarrad on 2026-10-07 (exact text used in the PR #846 replay test). Any change to this text needs his re-approval.
// Text is identical to the draft in scripts/messages-v2/replay/luna-prompt.md (PR #846).
export const LUNA_FRAMING = {
  role: "You are classifying the latest inbound text message in a two-way real-estate SMS conversation between a wholesaler and a property seller.",
  task: "Answer the outcome question and the escalation_reason question below, choosing exactly one option for each, using only the definitions given.",
  outcomeHeader: "Outcome options (name: definition):",
  escalationHeader: "Escalation reason options (name: definition):",
  format: "Respond with JSON only, matching the supplied schema: the chosen outcome, the chosen escalation_reason, and a confidence number from 0 to 1 for the chosen outcome.",
  userHeader: "Conversation, oldest first (the last line is the message to classify):",
} as const;

const Q = buildQuestions(false);
export const LUNA_OUTCOMES = Object.keys(OUTCOME_CRITERIA) as JevOutcome[];
export const LUNA_ESCALATION_REASONS = Object.keys(Q.escalation_reason.criteria);

export function lunaSystemPrompt(): string {
  const parts: string[] = [
    LUNA_FRAMING.role,
    LUNA_FRAMING.task,
    Q.outcome.instructions,
    LUNA_FRAMING.outcomeHeader,
    ...LUNA_OUTCOMES.map((name) => `${name}: ${OUTCOME_CRITERIA[name]}`),
    Q.escalation_reason.instructions,
    LUNA_FRAMING.escalationHeader,
    ...Object.entries(Q.escalation_reason.criteria).map(([name, def]) => `${name}: ${def}`),
    LUNA_FRAMING.format,
  ];
  return parts.join("\n\n");
}

export type ThreadLine = { direction: "inbound" | "outbound"; body: string };

/** Conversation as the user message. Direction labels are structure, not rules. */
export function lunaUserPrompt(thread: readonly ThreadLine[]): string {
  return [LUNA_FRAMING.userHeader, ...thread.map((m) => `[${m.direction}] ${m.body}`)].join("\n");
}

/** Strict JSON schema for the structured output. Enums come from the Jev code. */
export function lunaJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["outcome", "escalation_reason", "confidence"],
    properties: {
      outcome: { type: "string", enum: [...LUNA_OUTCOMES] },
      escalation_reason: { type: "string", enum: [...LUNA_ESCALATION_REASONS] },
      confidence: { type: "number" },
    },
  };
}
