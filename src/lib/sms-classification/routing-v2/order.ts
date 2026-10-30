import type { PropertyTypeOption, V2QuestionId } from "./questions";

/**
 * Routing order v2 — copied from ORDER-TABLE.md (results-chosen order, v7 replay:
 * order V4 + Okay/reaction = yes + land-price alert + Jarrad's 2026-10-30 Haiku ruling).
 * First match wins. Pinned by `routing-v2.test.ts`; never reorder without approval.
 */
export const DEFAULT_CUTOFF = 0.6;
/** Reason to sell uses a 40% cutoff (Jarrad, vault plan). */
export const REASON_TO_SELL_CUTOFF = 0.4;

export type V2Road =
  | "stop"
  | "ALERT_call_me"
  | "wrong_number_close"
  | "vacant_land_drip"
  | "ALERT_land_price"
  | "ALERT_commercial"
  | "listed_drip"
  | "text_only_reply"
  | "how_it_works_reply"
  | "ALERT_said_theyll_call"
  | "ALERT_reason_to_sell"
  | "price_check"
  | "book_appointment"
  | "maybe_later_drip"
  | "not_interested_drip"
  | "who_reply_drip"
  | "which_property_reply"
  | "location_reply"
  | "confirmed_owner_drip"
  | "reaction+book_appointment"
  | "driving_reply+book_appointment"
  | "bad_number";

/** A signal is a yes/no question id, or a property-type choice (`PT:<option>`). */
export type V2Signal = V2QuestionId | `PT:${PropertyTypeOption}`;

export type V2OrderStep = {
  /** ORDER-TABLE row number. */
  row: string;
  step: string;
  road: V2Road;
  signals: ReadonlyArray<{ signal: V2Signal; cutoff: number }>;
};

const c = (signal: V2Signal, cutoff = DEFAULT_CUTOFF) => ({ signal, cutoff });

export const V2_ORDER: ReadonlyArray<V2OrderStep> = [
  { row: "1", step: "legal_hostile", road: "stop", signals: [c("legal"), c("hostile")] },
  { row: "2", step: "asked_stop", road: "stop", signals: [c("asked_stop")] },
  { row: "2b", step: "asked_call", road: "ALERT_call_me", signals: [c("asked_call")] },
  { row: "3", step: "wrong", road: "wrong_number_close", signals: [c("wrong_person"), c("already_sold"), c("tenant")] },
  // Row 4: lot + named/talked price is promoted to ALERT_land_price in route.ts.
  { row: "4", step: "pt_lot", road: "vacant_land_drip", signals: [c("PT:lot")] },
  { row: "4", step: "pt_comm", road: "ALERT_commercial", signals: [c("PT:commercial")] },
  { row: "5", step: "listed", road: "listed_drip", signals: [c("listed")] },
  { row: "6", step: "text_only", road: "text_only_reply", signals: [c("text_only")] },
  { row: "7", step: "how_it_works", road: "how_it_works_reply", signals: [c("how_it_works")] },
  { row: "9", step: "inbound", road: "ALERT_said_theyll_call", signals: [c("inbound_call")] },
  { row: "10", step: "reason_to_sell", road: "ALERT_reason_to_sell", signals: [c("reason_to_sell", REASON_TO_SELL_CUTOFF)] },
  { row: "11", step: "price", road: "price_check", signals: [c("named_price"), c("talked_price")] },
  { row: "12", step: "book", road: "book_appointment", signals: [c("asked_offer"), c("open_to_selling"), c("future_action")] },
  { row: "13", step: "maybe_later", road: "maybe_later_drip", signals: [c("maybe_later")] },
  { row: "14", step: "not_interested", road: "not_interested_drip", signals: [c("not_interested")] },
  { row: "15", step: "who", road: "who_reply_drip", signals: [c("asked_who")] },
  { row: "16", step: "which_property", road: "which_property_reply", signals: [c("which_property")] },
  { row: "17", step: "where_located", road: "location_reply", signals: [c("where_located")] },
  { row: "18", step: "confirmed_owner", road: "confirmed_owner_drip", signals: [c("confirmed_owner")] },
  // Row 19: "Okay" alone always = yes (Jarrad 2026-10-30). Last, so any other yes beats it.
  { row: "19", step: "just_ok", road: "book_appointment", signals: [c("just_ok")] },
];

/** Runs alongside the order: either yes → one deduplicated "possible opportunity" alert. */
export const OPPORTUNITY_SIGNALS: ReadonlyArray<V2QuestionId> = ["own_other_property", "someone_else_property"];

/** Lot + any of these at the default cutoff → ALERT_land_price (Jarrad 2026-10-29). */
export const LAND_PRICE_SIGNALS: ReadonlyArray<V2QuestionId> = ["named_price", "talked_price"];
