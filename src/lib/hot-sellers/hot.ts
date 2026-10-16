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
  "hot_lead_event_failed",
];

/**
 * One engine word or reason string, as the engine writes it: a bare outcome
 * (`new_lead`), a model reason (`model:hot_lead`),
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
  // `model:new_lead_promoted` is NOT hot here: a promoted seller is alerted by
  // the promotion itself, never a second time through a leftover hold.
  return word === HOT_JEV_OUTCOME || HOT_ESCALATION_REASONS.includes(word);
}

/** Hot when Jev's outcome is new_lead or any reason the decision carries is hot. */
export function isHotSeller(input: {
  jevOutcome?: string | null;
  reasons?: readonly (string | null | undefined)[];
}): boolean {
  if (input.jevOutcome === HOT_JEV_OUTCOME) return true;
  return (input.reasons ?? []).some(isHotReason);
}

/*
 * Alert keys: one per hot EVENT (Messages v2 PR 2 "Alert and hand-off model").
 * hot_handoff:<inbound>  Sandra put the lead on My Leads because of this text.
 * hot_text:<inbound>     a hot text on a lead Jarrad already had.
 * hot_flag:<property>:<flagAt>  a hot hold (the flag's own timestamp, stable while it is open).
 */
export const hotHandoffKey = (inboundMessageId: string): string => `hot_handoff:${inboundMessageId}`;
export const hotTextKey = (inboundMessageId: string): string => `hot_text:${inboundMessageId}`;
export const hotFlagKey = (propertyId: string, flagAt: string): string => `hot_flag:${propertyId}:${flagAt}`;
/** Alert key for a hot text whose hand-off failed: once per inbound message. */
export const hotFailedKey = (inboundMessageId: string): string => `hot_failed:${inboundMessageId}`;

/**
 * Hot alerts start with PR 2. Hot events before this stay silent, so switching
 * the hot definition on does not page about weeks-old holds.
 */
export const HOT_ALERTS_START_ISO = "2026-10-15T00:00:00.000Z";
