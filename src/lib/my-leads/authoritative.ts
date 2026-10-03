import type { QueueRow } from "./queries"

/** What the single-row lookup said, or null/undefined when no lookup applies. */
export type AuthoritativeLookup =
  | { status: "found"; row: QueueRow }
  | { status: "unavailable" }
  | { status: "failed" }
  | null
  | undefined

export type AuthoritativePick = {
  /** The row to act on and render, or null when the lead must not be shown. */
  row: QueueRow | null
  /** Which input won. `removed` means the lookup says the lead is not in the queue. */
  source: "list" | "lookup" | "pin" | "removed" | "none"
}

const episodeTime = (row: QueueRow): number => {
  const parsed = Date.parse(row.assignedAt ?? row.initializedAt)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/**
 * True when `candidate` is strictly newer than `current` for the same lead.
 * A different assignment episode is decided by the episode's own timestamp
 * (assignedAt, else initializedAt); the same episode by queueVersion. A stage
 * difference never decides anything: stages move forward and backward within
 * an episode, so only episode and version order copies.
 */
export function isNewerCopy(candidate: QueueRow, current: QueueRow): boolean {
  if (candidate.assignmentEpisodeId !== current.assignmentEpisodeId) {
    const a = episodeTime(candidate)
    const b = episodeTime(current)
    return Number.isFinite(a) && Number.isFinite(b) ? a > b : false
  }
  return candidate.queueVersion > current.queueVersion
}

/** The newest of several list copies of one lead. */
export function newestCopy(copies: readonly QueueRow[]): QueueRow | null {
  let best: QueueRow | null = null
  for (const copy of copies) if (!best || isNewerCopy(copy, best)) best = copy
  return best
}

/**
 * The single place that decides which copy of the deep-linked lead is true.
 * - Lookup found: the newer of (list copy, lookup row) wins; ties keep the list
 *   copy so rows are never reordered. An older lookup never displaces a newer list row.
 * - Lookup unavailable: the lead is removed everywhere.
 * - Lookup failed: a list copy always wins; only without one is the last good
 *   pin kept. An old pin is never resurrected over a list row.
 * - No lookup: the list copy.
 */
export function pickAuthoritative(
  listCopy: QueueRow | null,
  lookup: AuthoritativeLookup,
  lastPin: QueueRow | null = null,
): AuthoritativePick {
  if (lookup?.status === "unavailable") return { row: null, source: "removed" }
  if (lookup?.status === "found") {
    if (!listCopy) return { row: lookup.row, source: "lookup" }
    return isNewerCopy(lookup.row, listCopy) ? { row: lookup.row, source: "lookup" } : { row: listCopy, source: "list" }
  }
  if (listCopy) return { row: listCopy, source: "list" }
  if (lookup?.status === "failed" && lastPin) return { row: lastPin, source: "pin" }
  return { row: null, source: "none" }
}
