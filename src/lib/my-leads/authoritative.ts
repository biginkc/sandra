import type { QueueRow } from "./queries"

/** What the single-row lookup said, or null/undefined when no lookup applies. */
export type AuthoritativeLookup =
  | { status: "found"; row: QueueRow }
  | { status: "unavailable" }
  | { status: "failed" }
  | null
  | undefined

export type AuthoritativePick = {
  /** The row to render, or null when the lead must not be shown. */
  row: QueueRow | null
  /** Which input won. `removed` means the lookup says the lead is not in the queue. */
  source: "list" | "lookup" | "pin" | "removed" | "none"
}

const episodeTime = (row: QueueRow): number => Date.parse(row.assignedAt ?? row.initializedAt)

/**
 * True when `candidate` is strictly newer than `current` for the same lead: a
 * different assignment episode is decided by the episode's own timestamp
 * (assignedAt, else initializedAt), the same episode by queueVersion. There are no
 * read times anywhere in this decision, and a stage difference never decides.
 * queueVersion does not version the whole property, so an exact tie is NOT proof of
 * equal data: this ranking is for DISPLAY only. Commands re-read the row through
 * the single-row lookup and never trust a list copy for their preconditions.
 */
export function isNewerCopy(candidate: QueueRow, current: QueueRow): boolean {
  if (candidate.assignmentEpisodeId !== current.assignmentEpisodeId) {
    const a = episodeTime(candidate)
    const b = episodeTime(current)
    return Number.isFinite(a) && Number.isFinite(b) ? a > b : false
  }
  return candidate.queueVersion > current.queueVersion
}

/** The newest of several list copies of one lead; on a tie the first one stays. */
export function newestCopy(copies: readonly QueueRow[]): QueueRow | null {
  let best: QueueRow | null = null
  for (const copy of copies) if (!best || isNewerCopy(copy, best)) best = copy
  return best
}

/**
 * Which copy of a lead to DISPLAY.
 * - Lookup found: a strictly newer list copy wins; otherwise (older, or an exact
 *   tie) the lookup wins. An older lookup never displaces a newer list row.
 * - Lookup unavailable: the lead is removed everywhere.
 * - Lookup failed: a list copy always wins; only without one is the last good pin
 *   kept. An old pin is never resurrected over a list row.
 * - No lookup: the list copy.
 */
export function pickAuthoritative(
  listCopy: QueueRow | null,
  lookup: AuthoritativeLookup,
  lastPin: QueueRow | null = null,
): AuthoritativePick {
  if (lookup?.status === "unavailable") return { row: null, source: "removed" }
  if (lookup?.status === "found") {
    if (listCopy && isNewerCopy(listCopy, lookup.row)) return { row: listCopy, source: "list" }
    return { row: lookup.row, source: "lookup" }
  }
  if (listCopy) return { row: listCopy, source: "list" }
  if (lookup?.status === "failed" && lastPin) return { row: lastPin, source: "pin" }
  return { row: null, source: "none" }
}
