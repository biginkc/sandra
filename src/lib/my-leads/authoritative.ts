import type { QueueRow } from "./queries"

/** One copy of a lead and when the read it came from was taken (snapshotAt). */
export type Copy = { row: QueueRow; at: string | null }

/** What the single-row lookup said, or null/undefined when no lookup applies. */
export type AuthoritativeLookup =
  | { status: "found"; row: QueueRow; at: string | null }
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

const time = (value: string | null): number => (value ? Date.parse(value) : Number.NaN)
const episodeTime = (row: QueueRow): number => Date.parse(row.assignedAt ?? row.initializedAt)

/**
 * True when `candidate` is strictly newer than `current` for the same lead.
 * A different assignment episode is decided by the episode's own timestamp
 * (assignedAt, else initializedAt); the same episode by queueVersion. With equal
 * episode and version, the copy from the newer read wins, because queueVersion
 * does not version the whole property (a status change does not bump it). A stage
 * difference or list position never decides anything.
 */
export function isNewerCopy(candidate: Copy, current: Copy): boolean {
  if (candidate.row.assignmentEpisodeId !== current.row.assignmentEpisodeId) {
    const a = episodeTime(candidate.row)
    const b = episodeTime(current.row)
    return Number.isFinite(a) && Number.isFinite(b) ? a > b : false
  }
  if (candidate.row.queueVersion !== current.row.queueVersion) return candidate.row.queueVersion > current.row.queueVersion
  const a = time(candidate.at)
  const b = time(current.at)
  return Number.isFinite(a) && Number.isFinite(b) ? a > b : false
}

/** The newest of several list copies of one lead. */
export function newestCopy(copies: readonly Copy[]): Copy | null {
  let best: Copy | null = null
  for (const copy of copies) if (!best || isNewerCopy(copy, best)) best = copy
  return best
}

/**
 * The single place that decides which copy of the deep-linked lead is true.
 * - Lookup found: the newer of (list copy, lookup row) wins; a full tie keeps the
 *   list copy so rows are never reordered. An older lookup never displaces a newer list row.
 * - Lookup unavailable: the lead is removed everywhere.
 * - Lookup failed: a list copy always wins; only without one is the last good
 *   pin kept. An old pin is never resurrected over a list row.
 * - No lookup: the list copy.
 */
export function pickAuthoritative(
  listCopy: Copy | null,
  lookup: AuthoritativeLookup,
  lastPin: QueueRow | null = null,
): AuthoritativePick {
  if (lookup?.status === "unavailable") return { row: null, source: "removed" }
  if (lookup?.status === "found") {
    const looked: Copy = { row: lookup.row, at: lookup.at }
    if (!listCopy) return { row: lookup.row, source: "lookup" }
    return isNewerCopy(looked, listCopy) ? { row: lookup.row, source: "lookup" } : { row: listCopy.row, source: "list" }
  }
  if (listCopy) return { row: listCopy.row, source: "list" }
  if (lookup?.status === "failed" && lastPin) return { row: lastPin, source: "pin" }
  return { row: null, source: "none" }
}
