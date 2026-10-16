/**
 * "Already sold" wording. A seller who says the property is sold must never get
 * the not-interested template (its "mind if I check back in 6-12 months?" ask
 * is wrong for a home that is gone); the conversation is held for a person
 * with reason `sold_needs_human`.
 *
 * Source: .planning/messages-v2/RULES-PROPOSAL.md section 2.1, NI-1 "Must NOT
 * fire" clause (`"sold", "just sold", "already sold"`), the exclusion that came
 * with the approved proposal. `been sold` and `it is sold` were added by
 * Jarrad's build brief (2026-10-07). Every entry contains the word "sold", so
 * a whole-word match on it is equivalent to the list; the list is kept as the
 * auditable record. Changing it needs human approval of the exact text.
 */
export const SOLD_PHRASES = [
  "sold",
  "just sold",
  "already sold",
  "been sold",
  "it is sold",
] as const;

export const SOLD_NEEDS_HUMAN_REASON = "sold_needs_human";

const SOLD_PATTERNS = SOLD_PHRASES.map(
  (phrase) => new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "i"),
);

export function isSoldInbound(body: string | null | undefined): boolean {
  if (typeof body !== "string" || body.length === 0) return false;
  return SOLD_PATTERNS.some((pattern) => pattern.test(body));
}
