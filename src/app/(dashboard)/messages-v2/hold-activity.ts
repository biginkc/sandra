import type { OpenHold, RunWithSteps } from "./types";

/** Most holds the server sorts together; above this the column says so. */
export const HOLD_SORT_CAP = 1500;

/**
 * When anything last happened on this hold: the newest of its start, its latest
 * run (the seller's latest text), that run's latest step,. `since` alone is the OLDEST source timestamp, so a fresh seller
 * text on an old hold would otherwise be buried.
 */
export function holdActivityMs(hold: OpenHold<RunWithSteps>): number | null {
  const stamps = [
    hold.since,
    hold.run?.started_at,
    hold.run?.completed_at,
    ...(hold.run?.steps ?? []).map((st) => st.created_at),
  ]
    .map((v) => (v ? Date.parse(v) : Number.NaN))
    .filter((n) => Number.isFinite(n));
  return stamps.length ? Math.max(...stamps) : null;
}

/** Newest activity first. A hold with no known time sorts last, never first by accident. */
export function sortNewestFirst(holds: readonly OpenHold<RunWithSteps>[]): OpenHold<RunWithSteps>[] {
  const t = (h: OpenHold<RunWithSteps>) => holdActivityMs(h) ?? Number.NEGATIVE_INFINITY;
  return [...holds].sort((a, b) => (t(a) === t(b) ? a.id.localeCompare(b.id) : t(b) - t(a)));
}
