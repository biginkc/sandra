/**
 * Zone-local range resolution for the Calendar page — extracted from
 * page.tsx (Codex round 1 on the month view) so `resolveWeek` /
 * `resolveMonth` are directly unit-testable without going through the
 * route module (Next.js validates a page file's exports, so test-only
 * exports can't live there).
 */
import { addDaysInZone, getDayBoundsInZone, wallTimeToUtc } from "@/lib/time/zoned";

import type { CalendarDayBounds } from "./types";

const WEEK_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Resolves the zone-local day-of-week (0=Sunday..6=Saturday) of a UTC
 * instant AS OBSERVED in `timeZone` — used to walk an anchor day back to
 * its week's Sunday. Formatting the same instant through the target zone
 * (rather than reading UTC fields) is what keeps this correct regardless
 * of what zone the server process itself runs in.
 */
function weekdayIndexInZone(instant: Date, timeZone: string): number {
  // Explicit `timeZone: timeZone` (not shorthand) — Turbopack's production
  // minifier inlined this helper into resolveWeek, renamed the parameter,
  // and left the shorthand key referencing a now-undefined `timeZone`
  // global: /calendar crashed in production with "ReferenceError: timeZone
  // is not defined" while dev, tests, and typecheck all passed.
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone,
    weekday: "short",
  }).format(instant);
  return WEEKDAY_INDEX[label] ?? 0;
}

/**
 * YYYY-MM-DD label of `instant`'s zone-local calendar date. Built from
 * `formatToParts` (numeric y/m/d, then joined explicitly) rather than a
 * locale-string shortcut like `en-CA` — same defensive approach as
 * `zoned.ts`'s internal `getZonedParts`, which this mirrors: don't trust
 * a locale's formatted output to always come back in a fixed shape.
 */
function zonedDateLabel(instant: Date, timeZone: string): string {
  // Explicit key for the same minifier-inlining hazard as weekdayIndexInZone.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return `${map.year}-${map.month}-${map.day}`;
}

/**
 * Resolves the anchor day (from `?week=`, defaulting to "today") to its
 * containing week's 7 zone-local day bounds, Sunday through Saturday (no
 * existing week-start convention found elsewhere in the app — Sunday per
 * the plan's fallback).
 *
 * The anchor string is converted through `wallTimeToUtc` at a fixed
 * midday wall-time rather than `new Date(anchor)` — parsing a bare
 * YYYY-MM-DD as UTC midnight and then asking "what zone-local day is
 * this" can land on the WRONG calendar day for zones behind UTC (e.g.
 * Pacific): midday avoids that edge entirely for every zone this app
 * supports, and reuses the same DST-safe wall-time boundary the rest of
 * the appointment feature is built on instead of ad hoc date math.
 */
export function resolveWeek(
  anchor: string | undefined,
  timeZone: string,
): { weekStartDate: string; days: CalendarDayBounds[] } {
  let anchorInstant: Date;
  if (anchor && WEEK_DATE_RE.test(anchor)) {
    const converted = wallTimeToUtc({ date: anchor, time: "12:00", timeZone });
    anchorInstant = converted.ok ? converted.utc : new Date();
  } else {
    anchorInstant = new Date();
  }

  const { dayStart: anchorDayStart } = getDayBoundsInZone(anchorInstant, timeZone);
  const weekday = weekdayIndexInZone(anchorDayStart, timeZone);
  const weekStart =
    weekday === 0 ? anchorDayStart : addDaysInZone(anchorDayStart, -weekday, timeZone);

  const days: CalendarDayBounds[] = [];
  let cursor = weekStart;
  for (let i = 0; i < 7; i++) {
    const next = addDaysInZone(cursor, 1, timeZone);
    days.push({
      date: zonedDateLabel(cursor, timeZone),
      startUtc: cursor.toISOString(),
      endUtc: next.toISOString(),
    });
    cursor = next;
  }

  return { weekStartDate: days[0].date, days };
}

/**
 * Month-view sibling of `resolveWeek`: resolves the anchor day to its
 * zone-local calendar MONTH, padded to full Sunday-to-Saturday grid rows
 * (35 or 42 cells — leading cells can fall in the previous month, trailing
 * ones in the next). Day bounds are walked with the same DST-safe
 * `addDaysInZone` stepper as the week, never +24h math; only the CELL
 * COUNT is computed with plain calendar arithmetic (a month's length is a
 * calendar fact, independent of zone).
 */
export function resolveMonth(
  anchor: string | undefined,
  timeZone: string,
): { monthKey: string; weekStartDate: string; days: CalendarDayBounds[] } {
  let anchorInstant: Date;
  if (anchor && WEEK_DATE_RE.test(anchor)) {
    const converted = wallTimeToUtc({ date: anchor, time: "12:00", timeZone });
    anchorInstant = converted.ok ? converted.utc : new Date();
  } else {
    anchorInstant = new Date();
  }

  const { dayStart: anchorDayStart } = getDayBoundsInZone(anchorInstant, timeZone);
  const monthKey = zonedDateLabel(anchorDayStart, timeZone).slice(0, 7);

  // First zone-local day of the month, then back to its week's Sunday —
  // same midday-wall-time trick as resolveWeek's anchor conversion.
  const firstConverted = wallTimeToUtc({
    date: `${monthKey}-01`,
    time: "12:00",
    timeZone,
  });
  const firstInstant = firstConverted.ok ? firstConverted.utc : anchorInstant;
  const { dayStart: monthFirstDayStart } = getDayBoundsInZone(
    firstInstant,
    timeZone,
  );
  const firstWeekday = weekdayIndexInZone(monthFirstDayStart, timeZone);
  const gridStart =
    firstWeekday === 0
      ? monthFirstDayStart
      : addDaysInZone(monthFirstDayStart, -firstWeekday, timeZone);

  const [yearNum, monthNum] = monthKey.split("-").map(Number);
  // Day 0 of the NEXT month = last day of this month (calendar fact).
  const daysInMonth = new Date(Date.UTC(yearNum, monthNum, 0)).getUTCDate();
  // Clamped to a 5-row floor (Codex round 1): a 28-day month starting on
  // Sunday (e.g. February 2026) otherwise produces exactly 28 cells — a
  // 4-row grid that visibly breaks the fixed-height 35/42-cell contract
  // the component and its callers document. The extra row is the next
  // month's first week, muted like any other outside-month cells.
  const cellCount = Math.max(
    35,
    Math.ceil((firstWeekday + daysInMonth) / 7) * 7,
  );

  const days: CalendarDayBounds[] = [];
  let cursor = gridStart;
  for (let i = 0; i < cellCount; i++) {
    const next = addDaysInZone(cursor, 1, timeZone);
    days.push({
      date: zonedDateLabel(cursor, timeZone),
      startUtc: cursor.toISOString(),
      endUtc: next.toISOString(),
    });
    cursor = next;
  }

  return { monthKey, weekStartDate: days[0].date, days };
}

