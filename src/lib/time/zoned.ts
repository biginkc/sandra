/**
 * Timezone-aware day-boundary and wall-clock helpers for named IANA zones.
 *
 * Built on `Intl.DateTimeFormat().formatToParts()` — no new dependency.
 * date-fns 4 (already in package.json) has no timezone support; we do NOT
 * add date-fns-tz. Every boundary is derived independently from a zone's
 * calendar day, never by adding/subtracting 24h in milliseconds, so DST
 * transitions (23h / 25h local days) are handled correctly.
 */

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

/** Reads the wall-clock date/time that `instant` displays in `timeZone`. */
function getZonedParts(instant: Date, timeZone: string): ZonedParts {
  // Throws RangeError for an unknown/invalid IANA zone — callers translate
  // that into the public 'invalid' result where relevant.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // "24" shows up for midnight under some engines even with h23; normalize.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** UTC-minutes offset (`local = utc + offset`) that `timeZone` has at `instant`. */
function getOffsetMinutes(instant: Date, timeZone: string): number {
  const p = getZonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUtc - instant.getTime()) / 60000;
}

/**
 * Candidate UTC-minute offsets that could apply to the given wall-clock time
 * in `timeZone`. Sampled 25h before/after the naive guess — comfortably
 * beyond any single DST shift — so both sides of a transition are seen.
 * Throws if `timeZone` is not a valid IANA zone.
 */
function sampleOffsets(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number[] {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const SPAN_MS = 25 * 60 * 60 * 1000;
  const before = getOffsetMinutes(new Date(guess - SPAN_MS), timeZone);
  const after = getOffsetMinutes(new Date(guess + SPAN_MS), timeZone);
  return Array.from(new Set([before, after]));
}

/**
 * For each candidate offset, builds the UTC instant it implies and verifies
 * (by re-reading it back through the zone) that it truly reproduces the
 * requested wall-clock time. Zero matches = nonexistent (DST gap). Two
 * matches = ambiguous (DST fall-back).
 */
function resolveCandidates(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  offsets: number[],
  timeZone: string,
): number[] {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const valid: number[] = [];
  for (const offsetMin of offsets) {
    const candidate = guess - offsetMin * 60000;
    const p = getZonedParts(new Date(candidate), timeZone);
    if (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute &&
      p.second === second
    ) {
      valid.push(candidate);
    }
  }
  return valid;
}

/**
 * Resolves local midnight for a calendar date to its UTC instant. Used
 * internally for day boundaries, where the date is always derived from a
 * real Date via `getZonedParts` (never user input), so it should resolve
 * on the first try. The forward search is a defensive fallback for the
 * (essentially unheard-of for real IANA zones) case of midnight itself
 * falling inside a DST gap.
 */
function resolveMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  for (let addMinutes = 0; addMinutes <= 180; addMinutes++) {
    const hour = Math.floor(addMinutes / 60);
    const minute = addMinutes % 60;
    const offsets = sampleOffsets(year, month, day, hour, minute, 0, timeZone);
    const resolved = resolveCandidates(year, month, day, hour, minute, 0, offsets, timeZone);
    if (resolved.length > 0) return new Date(Math.min(...resolved));
  }
  throw new Error(`Unable to resolve day boundary for ${year}-${month}-${day} in ${timeZone}`);
}

/**
 * UTC instants of the calendar-day boundaries (local midnight to next local
 * midnight) containing `now` in `timeZone`. On a DST transition day the
 * `dayEnd - dayStart` span is 23h or 25h, not always 24h.
 */
export function getDayBoundsInZone(now: Date, timeZone: string): { dayStart: Date; dayEnd: Date } {
  const { year, month, day } = getZonedParts(now, timeZone);
  const dayStart = resolveMidnightUtc(year, month, day, timeZone);
  const dayEnd = addDaysInZone(dayStart, 1, timeZone);
  return { dayStart, dayEnd };
}

/**
 * Boundary-safe day stepping: reads `day`'s calendar date in `timeZone`,
 * steps the calendar date by `days` (plain integer arithmetic — safe
 * because it never touches a UTC instant, only y/m/d), then re-derives
 * that target date's own local-midnight boundary from scratch. Never adds
 * `days * 24h` in milliseconds, so it is safe across DST transitions.
 */
export function addDaysInZone(day: Date, days: number, timeZone: string): Date {
  const { year, month, day: d } = getZonedParts(day, timeZone);
  const target = new Date(Date.UTC(year, month - 1, d + days));
  return resolveMidnightUtc(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    timeZone,
  );
}

/**
 * Returns `timeZone` when it is a usable IANA identifier, otherwise
 * "America/Chicago". The prefs column is free text (legacy writes,
 * imports), and Intl.DateTimeFormat throws RangeError on an unknown zone —
 * one malformed persisted value must degrade to the default, never crash a
 * dashboard render or a notification formatter. Callers that want the
 * fallback to be observable should log before calling; this helper itself
 * stays pure and synchronous.
 */
export function normalizeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "America/Chicago";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "America/Chicago";
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Converts a wall-clock date/time in a named zone to its UTC instant.
 *
 * - A time that never occurred because of a DST spring-forward gap
 *   (e.g. America/Chicago 2026-03-08 02:30) returns `{ ok: false, reason: 'nonexistent' }`.
 * - A time that occurred twice because of a DST fall-back (e.g. America/Chicago
 *   2026-11-01 01:30) resolves to the EARLIER of the two UTC instants (the
 *   occurrence under the still-in-effect DST offset).
 * - Malformed date/time strings, out-of-range components, invalid calendar
 *   dates (e.g. Feb 30), or an unknown IANA zone all return
 *   `{ ok: false, reason: 'invalid' }`.
 */
export function wallTimeToUtc(input: {
  date: string;
  time: string;
  timeZone: string;
}): { ok: true; utc: Date } | { ok: false; reason: "nonexistent" | "invalid" } {
  const dateMatch = DATE_RE.exec(input.date);
  const timeMatch = TIME_RE.exec(input.time);
  if (!dateMatch || !timeMatch) return { ok: false, reason: "invalid" };

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = timeMatch[3] ? Number(timeMatch[3]) : 0;

  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, reason: "invalid" };
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: "invalid" };

  // Reject calendar dates that don't exist (e.g. 2026-02-30) via UTC round-trip.
  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day
  ) {
    return { ok: false, reason: "invalid" };
  }

  let offsets: number[];
  try {
    offsets = sampleOffsets(year, month, day, hour, minute, second, input.timeZone);
  } catch {
    return { ok: false, reason: "invalid" }; // unknown IANA zone
  }

  const resolved = resolveCandidates(year, month, day, hour, minute, second, offsets, input.timeZone);
  if (resolved.length === 0) return { ok: false, reason: "nonexistent" };
  return { ok: true, utc: new Date(Math.min(...resolved)) };
}

/**
 * Today/Tomorrow/Yesterday/weekday-or-date label for `target` relative to
 * `now`, computed from each Date's calendar day IN `timeZone` — never from
 * raw millisecond deltas — so it stays correct across DST boundaries and
 * when the zone's calendar day disagrees with UTC's (e.g. evening Central
 * is already the next day in UTC).
 */
export function formatRelativeDay(target: Date, timeZone: string, now: Date = new Date()): string {
  const t = getZonedParts(target, timeZone);
  const n = getZonedParts(now, timeZone);
  const tUtc = Date.UTC(t.year, t.month - 1, t.day);
  const nUtc = Date.UTC(n.year, n.month - 1, n.day);
  const diffDays = Math.round((tUtc - nUtc) / (24 * 60 * 60 * 1000));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(target);
}
