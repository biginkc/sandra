import { HAIKU_OPTION_IDS, type HaikuAnswer, type HaikuFailure } from "./haiku";
import { DEFAULT_CUTOFF, LAND_PRICE_SIGNALS, type V2Road } from "./order";
import type { V2QuestionId } from "./questions";
import type { V2Decision } from "./route";

/**
 * Routing v2 PR-D: what happens with Haiku's second opinion (pure; Jarrad 2026-10-30).
 * - Haiku is asked only when routeV2 says it is eligible (haiku-eligibility.ts).
 * - Valid answer, confidence ≥0.50, known option → Haiku's road (route_v7 `hroad`).
 * - Valid "unsure" (needs_person or confidence <0.50) → Jev's road stands;
 *   Jev had none → ALERT_haiku_unsure.
 * - A Haiku-decided stop is never auto-suppressed: hold + alert "Possible stop request — please check".
 *   The same holds for a Jev stop in the 0.60–0.70 band when Haiku is unsure (PR-I).
 * - Invalid answer (incl. an option id not in the list) / transport / timeout / HTTP error → hold + escalate to Jarrad with the reason;
 *   zero automatic sends. Not the valid-unsure path.
 * No daily caps or spend reservations (Jarrad 2026-10-30).
 */
export const HAIKU_CONFIDENCE_CUTOFF = 0.5;
export const HAIKU_STOP_ALERT = "Possible stop request — please check";
export const HAIKU_ERROR_ALERT = "Haiku error — please check";

/** Haiku option → road (route_v7.py HMAP + just_ok). needs_person is deliberately absent. */
export const HAIKU_ROADS: Readonly<Record<string, V2Road>> = {
  legal: "stop", hostile: "stop", asked_stop: "stop",
  wrong_person: "wrong_number_close", already_sold: "wrong_number_close", tenant: "wrong_number_close",
  lot: "vacant_land_drip", commercial: "ALERT_commercial", listed: "listed_drip",
  asked_call: "ALERT_call_me", inbound_call: "ALERT_said_theyll_call", reason_to_sell: "ALERT_reason_to_sell",
  named_price: "price_check", talked_price: "price_check",
  asked_offer: "book_appointment", open_to_selling: "book_appointment", maybe_yes: "book_appointment",
  future_action: "book_appointment", just_ok: "book_appointment",
  maybe_later: "maybe_later_drip", not_interested: "not_interested_drip", asked_who: "who_reply_drip",
  which_property: "which_property_reply", where_located: "location_reply", location_reply: "location_reply",
  confirmed_owner: "confirmed_owner_drip", text_only: "text_only_reply", how_it_works: "how_it_works_reply",
};

export type FinalRoad = V2Road | "ALERT_haiku_unsure";
export type FinalDecision = {
  road: FinalRoad | null;
  by: "code" | "jev" | "haiku" | "jev_haiku_unsure" | "haiku_unsure" | "haiku_failed";
  /** true = nothing is sent automatically; a person must look. */
  hold: boolean;
  alert: string | null;
  failureReason: string | null;
};

export function shouldAskHaiku(d: V2Decision): boolean {
  return d.haiku !== null;
}

export function applyHaikuPolicy(
  d: V2Decision,
  haiku: HaikuAnswer | HaikuFailure | null,
  probabilities: Record<V2QuestionId, number>,
): FinalDecision {
  const base = d.provenance.by === "code" ? "code" : "jev";
  if (!shouldAskHaiku(d)) return { road: d.road, by: base, hold: false, alert: null, failureReason: null };
  if (haiku?.ok && !(HAIKU_OPTION_IDS as readonly string[]).includes(haiku.option)) {
    haiku = { ok: false, reason: "haiku_invalid:unknown_option" };
  }
  if (!haiku || !haiku.ok) {
    return { road: null, by: "haiku_failed", hold: true, alert: HAIKU_ERROR_ALERT, failureReason: haiku ? haiku.reason : "haiku_invalid:missing" };
  }
  let road: V2Road | null =
    haiku.option !== "needs_person" && haiku.confidence >= HAIKU_CONFIDENCE_CUTOFF ? (HAIKU_ROADS[haiku.option] ?? null) : null;
  if (road === "vacant_land_drip" && LAND_PRICE_SIGNALS.some((q) => probabilities[q] >= DEFAULT_CUTOFF)) road = "ALERT_land_price";
  if (road === "stop") return { road, by: "haiku", hold: true, alert: HAIKU_STOP_ALERT, failureReason: null };
  if (road) return { road, by: "haiku", hold: false, alert: null, failureReason: null };
  // PR-I (decided 2026-10-30): a Jev stop/legal/hostile in the 0.60–0.70 band that Haiku is
  // unsure about is never auto-suppressed: hold + alert "Possible stop request — please check".
  if (d.road === "stop") return { road: d.road, by: "jev_haiku_unsure", hold: true, alert: HAIKU_STOP_ALERT, failureReason: null };
  if (d.road) return { road: d.road, by: "jev_haiku_unsure", hold: false, alert: null, failureReason: null };
  return { road: "ALERT_haiku_unsure", by: "haiku_unsure", hold: false, alert: null, failureReason: null };
}
