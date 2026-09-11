import { addDaysInZone, getDayBoundsInZone, wallTimeToUtc } from "@/lib/time/zoned";

export const ACQUISITION_TIME_ZONE = "America/Chicago";
export const FIRST_CALL_WORKING_MINUTES = 30;
export const OFFER_NEEDED_HOURS = 12;
const MINUTE = 60_000;
const calendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: ACQUISITION_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
});

function valid(date: Date): void {
  if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid instant");
}

function workWindow(day: Date): { start: number; end: number } | null {
  const parts = Object.fromEntries(calendar.formatToParts(day).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return null;
  const start = wallTimeToUtc({ date, time: "09:00", timeZone: ACQUISITION_TIME_ZONE });
  const end = wallTimeToUtc({ date, time: "17:00", timeZone: ACQUISITION_TIME_ZONE });
  if (!start.ok || !end.ok) throw new RangeError("Unable to resolve working day");
  return { start: start.utc.getTime(), end: end.utc.getTime() };
}

/** Whole calendar days, not historic minutes; DST is resolved per local day. */
export function workingMinutesBetween(start: Date, end: Date): number {
  valid(start); valid(end);
  if (end <= start) return 0;
  let day = getDayBoundsInZone(start, ACQUISITION_TIME_ZONE).dayStart;
  let milliseconds = 0;
  while (day < end) {
    const window = workWindow(day);
    if (window) milliseconds += Math.max(0, Math.min(end.getTime(), window.end) - Math.max(start.getTime(), window.start));
    day = addDaysInZone(day, 1, ACQUISITION_TIME_ZONE);
  }
  return milliseconds / MINUTE;
}

export function workingDeadline(start: Date, minutes = FIRST_CALL_WORKING_MINUTES): Date {
  valid(start);
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError("Invalid working duration");
  if (minutes === 0) return new Date(start);
  let remaining = minutes * MINUTE;
  let day = getDayBoundsInZone(start, ACQUISITION_TIME_ZONE).dayStart;
  for (;;) {
    const window = workWindow(day);
    if (window) {
      const from = Math.max(start.getTime(), window.start);
      const available = Math.max(0, window.end - from);
      if (available >= remaining) return new Date(from + remaining);
      remaining -= available;
    }
    day = addDaysInZone(day, 1, ACQUISITION_TIME_ZONE);
  }
}

export type WarningInput = {
  stage: "not_contacted" | "contacted" | "needs_offer" | "offer_sent" | "under_contract";
  assignedAt: Date | null;
  firstCallAt: Date | null;
  clockEligible: boolean;
  stageEnteredAt: Date | null;
  nextAppointmentAt: Date | null;
  offerFollowUpAt: Date | null;
  archived: boolean;
};
export type WarningReason = "first_call_overdue" | "missing_next_step" | "offer_needed_overdue" | "offer_follow_up_overdue";

export function acquisitionWarnings(input: WarningInput, now: Date): {
  reasons: WarningReason[]; nextWarningAt: Date | null;
} {
  valid(now);
  const reasons: WarningReason[] = [];
  const upcoming: number[] = [];
  if (input.archived || input.stage === "under_contract") return { reasons, nextWarningAt: null };
  const deadline = (at: Date, reason: WarningReason) => {
    valid(at);
    if (at <= now) reasons.push(reason);
    else upcoming.push(at.getTime());
  };
  if (input.clockEligible && input.assignedAt && !input.firstCallAt) {
    deadline(workingDeadline(input.assignedAt), "first_call_overdue");
  }
  if (input.stage === "contacted") {
    if (!input.nextAppointmentAt || input.nextAppointmentAt <= now) reasons.push("missing_next_step");
    else deadline(input.nextAppointmentAt, "missing_next_step");
  }
  if (input.stage === "needs_offer" && input.stageEnteredAt) {
    deadline(new Date(input.stageEnteredAt.getTime() + OFFER_NEEDED_HOURS * 60 * MINUTE), "offer_needed_overdue");
  }
  if (input.stage === "offer_sent" && input.offerFollowUpAt) deadline(input.offerFollowUpAt, "offer_follow_up_overdue");
  return { reasons, nextWarningAt: upcoming.length ? new Date(Math.min(...upcoming)) : null };
}
