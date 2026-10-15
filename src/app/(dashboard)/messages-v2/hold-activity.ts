import type { OpenHold, RunWithSteps } from "./types";

/** Most holds the server sorts together; above this the column says so. */
export const HOLD_SORT_CAP = 5000;

/**
 * When anything last happened on this hold: the newest of its start, its latest
 * run (the seller's latest text), that run's latest step,. `since` alone is the OLDEST source timestamp, so a fresh seller
 * text on an old hold would otherwise be buried.
 */
export function holdActivityMs(hold: OpenHold<RunWithSteps>): number | null {
  const stamps = [
    hold.since,
    hold.last_activity,
    hold.run?.started_at,
    hold.run?.completed_at,
    ...(hold.run?.steps ?? []).map((st) => st.created_at),
  ]
    .map((v) => (v ? Date.parse(v) : Number.NaN))
    .filter((n) => Number.isFinite(n));
  return stamps.length ? Math.max(...stamps) : null;
}

/** A hold's place in the list: its activity time (null = unknown, sorts last) and id (the tiebreak). */
export type HoldCursor = { at: number | null; id: string };

export const holdCursor = (hold: OpenHold<RunWithSteps>): HoldCursor => ({ at: holdActivityMs(hold), id: hold.id });

/** Negative when `a` comes before `b` in the list: newest activity first, unknown time last, ties by id. */
export function compareHoldOrder(a: HoldCursor, b: HoldCursor): number {
  const ta = a.at ?? Number.NEGATIVE_INFINITY;
  const tb = b.at ?? Number.NEGATIVE_INFINITY;
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Newest activity first. A hold with no known time sorts last, never first by accident. */
export function sortNewestFirst(holds: readonly OpenHold<RunWithSteps>[]): OpenHold<RunWithSteps>[] {
  return [...holds].sort((a, b) => compareHoldOrder(holdCursor(a), holdCursor(b)));
}

/** Holds strictly after the cursor in list order (a keyset page: no offsets, so arrivals between requests cannot shift it). */
export function holdsAfter(sorted: readonly OpenHold<RunWithSteps>[], cursor: HoldCursor | null): OpenHold<RunWithSteps>[] {
  return cursor ? sorted.filter((h) => compareHoldOrder(holdCursor(h), cursor) > 0) : [...sorted];
}

/** A cursor from untrusted input: a finite number (or null) and a short string. It is only ever compared, never put in a query. */
export function parseHoldCursor(input: unknown): HoldCursor | null {
  if (!input || typeof input !== "object") return null;
  const { at, id } = input as { at?: unknown; id?: unknown };
  if (typeof id !== "string" || id.length === 0 || id.length > 100) return null;
  if (at !== null && !(typeof at === "number" && Number.isFinite(at))) return null;
  return { at: at as number | null, id };
}
