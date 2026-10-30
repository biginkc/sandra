/**
 * When a reply would go to Haiku for a second opinion (Jarrad 2026-10-30). PR-A only
 * records eligibility; no Haiku call is made.
 * (a) Jev has no answer; (b) the deciding Jev answer is 0.50–0.70; (c) reason to sell decided
 * at 0.40–0.50. A deciding answer ≥0.70 is never sent (stop/legal/hostile ≥0.70 is final).
 */
export type HaikuEligibility = "no_match" | "decider_band" | "rts_band" | null;

export const HAIKU_BAND_LOW = 0.5;
export const HAIKU_BAND_HIGH = 0.7;

export function haikuEligibility(
  deciding: { signal: string; probability: number } | null,
): HaikuEligibility {
  if (!deciding) return "no_match";
  if (deciding.signal === "reason_to_sell") return deciding.probability < HAIKU_BAND_LOW ? "rts_band" : null;
  if (deciding.probability >= HAIKU_BAND_LOW && deciding.probability < HAIKU_BAND_HIGH) return "decider_band";
  return null;
}
