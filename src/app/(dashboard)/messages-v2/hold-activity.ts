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

/** A hold's place in the order: its activity time (null = unknown, sorts last) and id (the tiebreak). */
type OrderKey = { at: string | null; id: string };
const orderKey = (hold: OpenHold<RunWithSteps>): OrderKey => ({ at: holdActivityAt(hold), id: hold.id });

/** Negative when `a` comes before `b` in the list: newest activity first, unknown time last, ties by id. */
export function compareHoldOrder(a: OrderKey, b: OrderKey): number {
  if (a.at !== b.at) {
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return a.at > b.at ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Newest activity first. A hold with no known time sorts last, never first by accident. */
export function sortNewestFirst(holds: readonly OpenHold<RunWithSteps>[]): OpenHold<RunWithSteps>[] {
  return [...holds].sort((a, b) => compareHoldOrder(orderKey(a), orderKey(b)));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_SNAPSHOT_IDS = 100;

/** "Show older" ids from untrusted input: an array of uuids, deduped, at most 100. Null when anything is off. */
export function parseSnapshotIds(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_SNAPSHOT_IDS) return null;
  if (!input.every((v) => typeof v === "string" && UUID.test(v))) return null;
  return [...new Set(input as string[])];
}
