/**
 * One place for every time the page shows or orders. Display is America/Chicago
 * (the same zone the day dividers and "yesterday" paging use), never the
 * viewer's browser zone. Ordering keeps Postgres microseconds.
 */
export const CHICAGO_TZ = "America/Chicago";

// Newer ICU puts a narrow no-break space before AM/PM; keep plain spaces so text is stable everywhere.
const plain = (s: string) => s.replace(/[  ]/g, " ");

const asDate = (v: string | number | Date) => (v instanceof Date ? v : new Date(v));

/** "7:30 PM" */
export const chicagoClock = (v: string | number | Date): string =>
  plain(asDate(v).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: CHICAGO_TZ }));

/** "Oct 14, 7:30 PM" */
export const chicagoDateClock = (v: string | number | Date): string =>
  plain(
    asDate(v).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: CHICAGO_TZ }),
  );

/** "Nov 6" */
export const chicagoMonthDay = (v: string | number | Date): string =>
  plain(asDate(v).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: CHICAGO_TZ }));

/**
 * A sortable key for a database timestamp: UTC, always six fractional digits
 * ("2026-10-14T12:00:00.123456Z"), so a plain string comparison orders by
 * microsecond. Date.parse alone drops everything under a millisecond.
 */
export function normalizeInstant(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  const sub = fraction.padEnd(6, "0").slice(3, 6); // digits below the millisecond
  return `${new Date(ms).toISOString().slice(0, 23)}${sub}Z`;
}
