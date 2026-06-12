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

/**
 * Register guard — the brand voice is professional, never slangy. The
 * prompts (first-pass + humanizer) already forbid these; this is the
 * runtime backstop so a model that ignores the instructions escalates
 * instead of texting a seller "hit me up". Word-boundary anchored, so
 * e.g. "Coolidge" does not trip "cool". Not exhaustive; false positives
 * escalate safely rather than sending.
 */
export const SLANG_REGEX =
  /\b(my bad|hit me up|no worries|gonna|wanna|for sure|all good|awesome|cool|lol|yo)\b/i;

/** Starts with a lowercase letter — lowercase mirroring is never allowed. */
export const STARTS_LOWERCASE_REGEX = /^[a-z]/;

/** Hard cap from the reply contract: one SMS segment. */
export const MAX_REPLY_BODY_LEN = 160;

export type SafetyVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "contains_dollar_amount"
        | "contains_numeric_amount"
        | "contains_commitment"
        | "contains_slang"
        | "starts_lowercase"
        | "too_long";
    };

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
  if (SLANG_REGEX.test(body)) {
    return { ok: false, reason: "contains_slang" };
  }
  if (STARTS_LOWERCASE_REGEX.test(body)) {
    return { ok: false, reason: "starts_lowercase" };
  }
  if (body.length > MAX_REPLY_BODY_LEN) {
    return { ok: false, reason: "too_long" };
  }
  return { ok: true };
}
