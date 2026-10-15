/**
 * What counts as a HOT seller (Messages v2 redesign, PR 2; Jarrad 2026-10-14):
 * the seller wants an offer or talked price. Hot sellers go to Jarrad on My
 * Leads with one Slack DM and one text; nothing else pings.
 *
 * Hot = Jev outcome `new_lead`, OR escalation reason `hot_lead` /
 * `call_request` / `price_or_offer`, OR the `price_offer` keyword gate.
 * This is the ONE definition: dispatch, the alert cron and the tape all read it.
 */

export const HOT_JEV_OUTCOME = "new_lead";
export const HOT_ESCALATION_REASONS: readonly string[] = ["hot_lead", "call_request", "price_or_offer"];
export const HOT_KEYWORD_TIER = "price_offer";

/** Hold reasons written when a hot seller's own hand-off failed: the hold that remains is still hot. */
export const HOT_HANDOFF_FAILED_REASONS: readonly string[] = [
  "jev_new_lead_promotion_failed",
  "hot_lead_assign_failed",
];

/**
 * One engine word or reason string, as the engine writes it: a bare outcome
 * (`new_lead`), a model reason (`model:hot_lead`, `model:new_lead_promoted`),
 * a keyword gate (`keyword:price_offer`), or a below-threshold Jev decision
 * (`jev_below_threshold:new_lead`). Exact, never substring: `price_quoted` is not hot.
 */
export function isHotReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const value = reason.trim();
  if (HOT_HANDOFF_FAILED_REASONS.includes(value)) return true;
  if (value === `keyword:${HOT_KEYWORD_TIER}`) return true;
  if (value === `jev_below_threshold:${HOT_JEV_OUTCOME}`) return true;
  const word = value.startsWith("model:") ? value.slice("model:".length) : value;
  return word === HOT_JEV_OUTCOME || word === "new_lead_promoted" || HOT_ESCALATION_REASONS.includes(word);
}

/** Hot when Jev's outcome is new_lead or any reason the decision carries is hot. */
export function isHotSeller(input: {
  jevOutcome?: string | null;
  reasons?: readonly (string | null | undefined)[];
}): boolean {
  if (input.jevOutcome === HOT_JEV_OUTCOME) return true;
  return (input.reasons ?? []).some(isHotReason);
}

/** The alert key for one hot promotion: once per property, ever. */
export const hotPromotionKey = (propertyId: string): string => `hot_promotion:${propertyId}`;
