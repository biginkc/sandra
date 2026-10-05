import { addDaysInZone, getDayBoundsInZone, wallTimeToUtc } from "@/lib/time/zoned";

/** The three one-tap picks. "Pick" (custom date and time) is chosen by the rep and never computed here. */
export type QuickPick = "tomorrow" | "three_days" | "next_week";
export type QuickPickKind = QuickPick | "custom";

export const QUICK_PICK_DAYS: Record<QuickPick, number> = {
  tomorrow: 1,
  three_days: 3,
  next_week: 7,
};

/** Jarrad's default quick-pick time of day (P1 Inputs). */
export const DEFAULT_QUICK_PICK_TIME = "10:00";
export const DEFAULT_QUICK_PICK_TIME_ZONE = "America/Chicago";

function localDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/**
 * The due instant for a quick pick: the local calendar day `days` after today's date in
 * `timeZone`, at `time` local. Built on calendar-day stepping, never `+24h`, so it is DST-safe.
 * A requested wall time that does not exist (spring-forward gap) moves forward an hour at a time.
 */
export function quickPickDueAt(
  pick: QuickPick,
  now: Date,
  opts: { time?: string; timeZone?: string } = {},
): Date {
  const timeZone = opts.timeZone ?? DEFAULT_QUICK_PICK_TIME_ZONE;
  const time = opts.time ?? DEFAULT_QUICK_PICK_TIME;
  const { dayStart } = getDayBoundsInZone(now, timeZone);
  const date = localDate(addDaysInZone(dayStart, QUICK_PICK_DAYS[pick], timeZone), timeZone);
  const [hh, mm] = time.split(":");
  for (let shift = 0; shift < 4; shift += 1) {
    const hour = String(Math.min(23, Number(hh) + shift)).padStart(2, "0");
    const result = wallTimeToUtc({ date, time: `${hour}:${mm ?? "00"}`, timeZone });
    if (result.ok) return result.utc;
  }
  throw new Error(`quickPickDueAt: cannot resolve ${date} ${time} in ${timeZone}`);
}
