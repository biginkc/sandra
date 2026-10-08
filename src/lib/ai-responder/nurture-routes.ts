import type { JevListingStatus, JevReadyTimeframe } from "@/lib/sms-classification/types";

/** Pure routing data for the nurture auto-drip (safe to import from client code). */
/** The three drips an owner maps, one per nurture route. */
export type NurtureDripKey = "maybe_later" | "check_in_60" | "listed_not_selling" | "hot_book_appointment";

/** Exact drip names pre-selected in the owner control when present. */
export const NURTURE_DRIP_DEFAULT_NAMES: Record<NurtureDripKey, string> = {
  maybe_later: "Maybe later",
  check_in_60: "Check in every 60 days",
  listed_not_selling: "Listed, not selling",
  hot_book_appointment: "Book appointment",
};

/**
 * Days after enrolment before the drip's FIRST text may go out, so it never
 * lands right after the nurture reply. Confirmed by Jarrad 2026-10-07.
 * Keyed by what Jev read: the timeframe for "Maybe later", else the route.
 */
export const NURTURE_FIRST_SEND_DELAY_DAYS = {
  one_to_six_months: 30,
  six_to_twelve_months: 180,
  check_in_60: 60,
  listed_not_selling: 14,
} as const;

export type NurtureRoute =
  /** Ready within 30 days: a person is alerted AND the Book appointment drip starts (no extra delay). */
  | { kind: "person"; drip: "hot_book_appointment" }
  | { kind: "drip"; drip: NurtureDripKey; delayDays: number };

/**
 * Approved routing (Jarrad 2026-10-07). The listing check wins over the
 * timeframe; within 30 days (not listed) goes to a person; the rest by timeframe.
 */
export function routeNurture(a: {
  readyTimeframe: JevReadyTimeframe | null | undefined;
  listingStatus: JevListingStatus | null | undefined;
}): NurtureRoute {
  if (a.listingStatus === "listed") {
    return { kind: "drip", drip: "listed_not_selling", delayDays: NURTURE_FIRST_SEND_DELAY_DAYS.listed_not_selling };
  }
  switch (a.readyTimeframe) {
    case "within_30_days":
      return { kind: "person", drip: "hot_book_appointment" };
    case "one_to_six_months":
      return { kind: "drip", drip: "maybe_later", delayDays: NURTURE_FIRST_SEND_DELAY_DAYS.one_to_six_months };
    case "six_to_twelve_months":
      return { kind: "drip", drip: "maybe_later", delayDays: NURTURE_FIRST_SEND_DELAY_DAYS.six_to_twelve_months };
    default:
      // over_a_year, not_stated, uncertain, or no valid answer.
      return { kind: "drip", drip: "check_in_60", delayDays: NURTURE_FIRST_SEND_DELAY_DAYS.check_in_60 };
  }
}
