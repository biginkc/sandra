import type { PostCallExtras } from "./types"

/**
 * The post-call prompt's note and quick next step, kept with the saved attempt's idempotency key so
 * no recovery path can lose them: a late success after the prompt closed, "already saved", and
 * Refresh-and-close all flush the entry for the attempt's key. Each extra has its own idempotency
 * key (the prompt's submissionId), so flushing twice cannot duplicate a note or an appointment.
 *
 * Memory plus sessionStorage (try/catch everywhere), so a reload mid-save can still finish. The
 * entry is removed only after the server confirms both extras, or after 24 hours.
 */
export type ExtrasEntry = {
  viewerUserId: string
  attemptKey: string
  propertyId: string
  memberId: string
  extras: PostCallExtras
  createdAt: number
}

export const EXTRAS_STORAGE_KEY = "sandra:my-leads:post-call-extras:v1"
export const EXTRAS_TTL_MS = 24 * 60 * 60 * 1000

const memory = new Map<string, ExtrasEntry>()

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage
  } catch {
    return null
  }
}

function valid(value: unknown, now: number): value is ExtrasEntry {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  const e = v.extras as Record<string, unknown> | undefined
  return (
    typeof v.viewerUserId === "string" && typeof v.attemptKey === "string" && typeof v.propertyId === "string" &&
    typeof v.memberId === "string" && typeof v.createdAt === "number" && now - v.createdAt < EXTRAS_TTL_MS &&
    typeof e === "object" && e !== null && typeof e.submissionId === "string"
  )
}

function readAll(now: number): ExtrasEntry[] {
  const store = storage()
  if (!store) return []
  try {
    const parsed = JSON.parse(store.getItem(EXTRAS_STORAGE_KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((item): item is ExtrasEntry => valid(item, now)) : []
  } catch {
    return []
  }
}

/** Writes the list back to sessionStorage (removing the key when empty). Memory still holds entries if storage throws. */
function writeAll(list: ExtrasEntry[]) {
  const store = storage()
  if (!store) return
  try {
    if (list.length === 0) store.removeItem(EXTRAS_STORAGE_KEY)
    else store.setItem(EXTRAS_STORAGE_KEY, JSON.stringify(list))
  } catch {
    // Storage is a convenience; memory still holds the entry.
  }
}

const id = (viewerUserId: string, attemptKey: string) => `${viewerUserId}|${attemptKey}`
const same = (a: { viewerUserId: string; attemptKey: string }, b: { viewerUserId: string; attemptKey: string }) =>
  a.viewerUserId === b.viewerUserId && a.attemptKey === b.attemptKey

/**
 * Every write starts from what sessionStorage holds, not from memory: after a reload older entries
 * live only in storage, and writing back just the in-memory ones would silently drop them.
 */
export function putExtras(entry: Omit<ExtrasEntry, "createdAt">, now = Date.now()) {
  const full: ExtrasEntry = { ...entry, createdAt: now }
  memory.set(id(entry.viewerUserId, entry.attemptKey), full)
  writeAll([...readAll(now).filter((item) => !same(item, full)), full])
}

export function hasExtras(viewerUserId: string, attemptKey: string): boolean {
  return Boolean(getExtras(viewerUserId, attemptKey))
}

/** The entry for an attempt key (memory first, then a reload's sessionStorage copy). Does not remove it. */
export function getExtras(viewerUserId: string, attemptKey: string, now = Date.now()): ExtrasEntry | null {
  const hit = memory.get(id(viewerUserId, attemptKey))
  if (hit) return now - hit.createdAt < EXTRAS_TTL_MS ? hit : null
  const restored = readAll(now).find((item) => item.viewerUserId === viewerUserId && item.attemptKey === attemptKey)
  if (restored) memory.set(id(viewerUserId, attemptKey), restored)
  return restored ?? null
}

export function clearExtras(viewerUserId: string, attemptKey: string, now = Date.now()) {
  memory.delete(id(viewerUserId, attemptKey))
  writeAll(readAll(now).filter((item) => !(item.viewerUserId === viewerUserId && item.attemptKey === attemptKey)))
}

/** A user change keeps only that user's entries (the submission store does the same for its records). */
export function discardOtherViewerExtras(viewerUserId: string, now = Date.now()) {
  for (const [key, entry] of memory) if (entry.viewerUserId !== viewerUserId) memory.delete(key)
  writeAll(readAll(now).filter((item) => item.viewerUserId === viewerUserId))
}

/** Sign-out: forget every entry, in memory and in storage. */
export function clearAllExtras() {
  memory.clear()
  writeAll([])
}

/** Test helper: a reload clears memory and leaves sessionStorage alone. */
export function simulateExtrasReloadForTests() {
  memory.clear()
}

export function resetExtrasStoreForTests() {
  memory.clear()
  try {
    storage()?.removeItem(EXTRAS_STORAGE_KEY)
  } catch {
    // ignore
  }
}
