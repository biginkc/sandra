import { normalizeInstant } from "./chicago-time";
import type { OpenHold, RunWithSteps } from "./types";

/**
 * When anything last happened on this hold, as a microsecond-precision sortable string: the newest of its own
 * sources (flag, pending decision / review / draft), its latest run (the seller's latest text) and that run's
 * steps. `since` alone is the OLDEST source time, so a fresh seller text on an old hold would otherwise be buried.
 */
export function holdActivityAt(hold: OpenHold<RunWithSteps>): string | null {
  const stamps = [
    hold.since,
    hold.last_activity,
    hold.related_activity,
    hold.run?.started_at,
    ...(hold.run?.steps ?? []).map((st) => st.created_at),
  ]
    .map((v) => normalizeInstant(v))
    .filter((v): v is string => v !== null);
  return stamps.length ? stamps.reduce((a, b) => (a >= b ? a : b)) : null;
}

/** A hold's place in the list: its activity time (null = unknown, sorts last) and id (the tiebreak). */
export type HoldCursor = { at: string | null; id: string };

export const holdCursor = (hold: OpenHold<RunWithSteps>): HoldCursor => ({ at: holdActivityAt(hold), id: hold.id });

/** Negative when `a` comes before `b` in the list: newest activity first, unknown time last, ties by id. */
export function compareHoldOrder(a: HoldCursor, b: HoldCursor): number {
  if (a.at !== b.at) {
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return a.at > b.at ? -1 : 1;
  }
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

/** A cursor from untrusted input: a normalized timestamp (or null) and a uuid (every hold is keyed by its property). It is only ever compared, never put in a query. */
export function parseHoldCursor(input: unknown): HoldCursor | null {
  if (!input || typeof input !== "object") return null;
  const { at, id } = input as { at?: unknown; id?: unknown };
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  if (at !== null && !(typeof at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at))) return null;
  return { at: at as string | null, id };
}
