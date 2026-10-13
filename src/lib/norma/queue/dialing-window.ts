import { STATE_TO_TZ } from "@/lib/messaging/quiet-hours";

// Dialing window (Jarrad 2026-10-07): half-open [09:00, 19:30) seller-local, Monday to Saturday.
// All wall-clock math is done in the IANA zone via Intl.DateTimeFormat; 24h is never added to an instant.

export const WINDOW_OPEN_MINUTES = 9 * 60;
export const WINDOW_CLOSE_MINUTES = 19 * 60 + 30;

export type LocalParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  dow: number; // 0 = Sunday
};

export type CivilDate = { year: number; month: number; day: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, fmt);
  }
  return fmt;
}

export function zoneForState(state: string | null | undefined): string | null {
  if (!state) return null;
  const zone = STATE_TO_TZ[state.trim().toUpperCase()];
  return zone ?? null;
}

export function dayOfWeek(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function localParts(instant: Date, zone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(instant)) {
    if (part.type !== "literal") out[part.type] = parseInt(part.value, 10);
  }
  const date = { year: out.year, month: out.month, day: out.day };
  return {
    ...date,
    hour: out.hour % 24,
    minute: out.minute,
    second: out.second,
    dow: dayOfWeek(date),
  };
}

function offsetMs(instantMs: number, zone: string): number {
  const p = localParts(new Date(instantMs), zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The instant at which the zone's wall clock reads `date` `hour`:`minute`. */
export function zonedTimeToInstant(zone: string, date: CivilDate, hour: number, minute: number): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0);
  const first = naive - offsetMs(naive, zone);
  const second = naive - offsetMs(first, zone);
  return new Date(second);
}

export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function isDialingDay(date: CivilDate): boolean {
  return dayOfWeek(date) !== 0;
}

/** First dialing day strictly after `date`. */
export function nextDialingDateAfter(date: CivilDate): CivilDate {
  let next = addCivilDays(date, 1);
  while (!isDialingDay(next)) next = addCivilDays(next, 1);
  return next;
}

export function civilDateKey(date: CivilDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export function isWithinDialingWindow(state: string | null | undefined, now: Date): boolean {
  const zone = zoneForState(state);
  if (!zone) return false;
  const p = localParts(now, zone);
  if (p.dow === 0) return false;
  const minutes = p.hour * 60 + p.minute;
  return minutes >= WINDOW_OPEN_MINUTES && minutes < WINDOW_CLOSE_MINUTES;
}

/** Earliest instant >= now inside the dialing window, or null for an unknown state. */
export function nextWindowStart(state: string | null | undefined, now: Date): Date | null {
  const zone = zoneForState(state);
  if (!zone) return null;
  if (isWithinDialingWindow(state, now)) return now;
  const p = localParts(now, zone);
  const today: CivilDate = { year: p.year, month: p.month, day: p.day };
  const minutes = p.hour * 60 + p.minute;
  if (isDialingDay(today) && minutes < WINDOW_OPEN_MINUTES) return zonedTimeToInstant(zone, today, 9, 0);
  return zonedTimeToInstant(zone, nextDialingDateAfter(today), 9, 0);
}
