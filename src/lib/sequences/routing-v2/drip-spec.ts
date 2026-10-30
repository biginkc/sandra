import { APPROVED_DRIPS } from "./approved-drips.fixture";
import { SLOT_TIME_TOKEN, type SlotWindow } from "./slot-time";

/**
 * Routing v2 versioned drips (PR-C). The seed migration
 * `20261030140000_routing_v2_versioned_drips.sql` must match this spec exactly
 * (pinned by drip-spec.test.ts). Texts come from APPROVED_DRIPS; the only change is the
 * booking texts' fixed clock time ("2:00") becoming {{slot_time}}, filled at send time.
 */
export type RoutingV2DripKey =
  | "price_too_high"
  | "said_theyd_call"
  | "vacant_land"
  | "book_appointment"
  | "listed_not_selling";

export type RoutingV2SeedStep = { day: number; body: string; slotWindow: SlotWindow | null };

/** Replaces the single clock time in an approved booking text with the slot token. */
export function tokenizeSlotTime(approved: string): string {
  // Approved texts written with the token already (A-005) are used verbatim.
  if (approved.includes(SLOT_TIME_TOKEN)) {
    if (approved.split(SLOT_TIME_TOKEN).length !== 2) throw new Error(`expected one slot token in: ${approved}`);
    return approved;
  }
  const matches = approved.match(/\b\d{1,2}:\d{2}\b/g) ?? [];
  if (matches.length !== 1) throw new Error(`expected exactly one clock time in: ${approved}`);
  return approved.replace(/\b\d{1,2}:\d{2}\b/, SLOT_TIME_TOKEN);
}

const booking = (texts: readonly string[], days: number[], windows: SlotWindow[]): RoutingV2SeedStep[] =>
  texts.map((t, i) => ({ day: days[i]!, body: tokenizeSlotTime(t), slotWindow: windows[i]! }));
const plain = (texts: readonly string[], days: number[]): RoutingV2SeedStep[] =>
  texts.map((t, i) => ({ day: days[i]!, body: t, slotWindow: null }));

/**
 * Slot windows keep the approved words true: a text that says "this morning" only goes out
 * when its slot is a morning slot, "afternoon" texts only with afternoon slots.
 */
export const ROUTING_V2_DRIPS = {
  price_too_high: {
    name: "Price too high (routing v2)",
    steps: plain(APPROVED_DRIPS.price_too_high, [30, 75, 135, 225, 315, 435, 555]),
    thenKey: null,
  },
  vacant_land: {
    name: "Vacant land (routing v2)",
    steps: plain(APPROVED_DRIPS.vacant_land, [0, 30, 90, 180, 365]),
    thenKey: null,
  },
  said_theyd_call: {
    name: "Said they'd call (routing v2)",
    steps: booking(APPROVED_DRIPS.said_theyd_call, [1, 2, 3, 5, 7, 10], [
      "any", // at 2:30 today
      "any", // at 1:15 today
      "afternoon", // 4:45 this afternoon before we wrap up
      "afternoon", // hold 4:15 this afternoon
      "any", // a 3:30 cancel today
      "afternoon", // one afternoon slot at 2:45
    ]),
    // No automatic handoff at drip end: disabled pending Jarrad's decision (Master A-004).
    thenKey: null,
  },
  /** First 6 steps; the migration appends the existing drip's later steps (step_index >= 6). */
  book_appointment: {
    name: "Book appointment (routing v2)",
    steps: booking(APPROVED_DRIPS.book_appointment_first6, [1, 2, 4, 5, 7, 8], [
      "any", // at 2:00 today
      "afternoon", // a 3:15 just opened up this afternoon
      "morning", // 11:30 this morning
      "afternoon", // one afternoon spot left today at 4:00
      "any", // a 1:30 cancel today
      "any", // last open spot I have today is 3:00
    ]),
    thenKey: null,
  },
  /** Only the new step; the migration copies every existing step around it by day. */
  listed_not_selling: {
    name: "Listed, not selling (routing v2)",
    steps: plain([APPROVED_DRIPS.listed_not_selling_day2], [2]),
    thenKey: null,
  },
} as const satisfies Record<
  RoutingV2DripKey,
  { name: string; steps: RoutingV2SeedStep[]; thenKey: RoutingV2DripKey | null }
>;
