/**
 * Output-safety validator for AI-generated reply bodies.
 *
 * Runs AFTER Claude returns its structured output but BEFORE we hand
 * the body to `sendSmsToContact`. The LLM is prompted to never quote a
 * price or make commitments — this validator is the defense-in-depth
 * that catches the model when it ignores the instructions.
 *
 * If the body violates any rule, the whole message is routed to
 * escalation instead (property flagged, no send). Pure function.
 */

const DOLLAR_AMOUNT_REGEX = /\$\s*\d/;
const NUMBER_WITH_SCALE_REGEX = /\b\d+\s*(k|thousand|million)\b/i;
/**
 * Commitment / promise language. Not an exhaustive list; we cover the
 * phrases a flat-toned LLM most commonly slips into. Any false
 * positives escalate safely rather than sending.
 */
const COMMITMENT_REGEX =
  /\b(promise|guarantee|we will (buy|purchase|close)|we can (buy|purchase|close)|we'?ll (buy|purchase|close|definitely))\b/i;

export type SafetyVerdict =
  | { ok: true }
  | { ok: false; reason: "contains_dollar_amount" | "contains_numeric_amount" | "contains_commitment" };

export function validateAiReplyBody(body: string): SafetyVerdict {
  if (DOLLAR_AMOUNT_REGEX.test(body)) {
    return { ok: false, reason: "contains_dollar_amount" };
  }
  if (NUMBER_WITH_SCALE_REGEX.test(body)) {
    return { ok: false, reason: "contains_numeric_amount" };
  }
  if (COMMITMENT_REGEX.test(body)) {
    return { ok: false, reason: "contains_commitment" };
  }
  return { ok: true };
}
