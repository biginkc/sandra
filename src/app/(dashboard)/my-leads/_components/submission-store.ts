import type { Json } from "@/lib/supabase/types"

/**
 * Idempotency record for a My Leads save, kept past the dialog that started it.
 *
 * The record lives in a module-level map (so it survives a dialog closing, an unmount and
 * client-side navigation) and is mirrored to sessionStorage (so it survives a reload) with
 * NON-SENSITIVE fields only. The payload (notes, phone numbers, names, follow-up text,
 * recording links) is memory-only: it is never written to storage, so after a reload the
 * record keeps its key and route but not the values.
 */
export type SubmissionStatus = "fresh" | "uncertain" | "already-saved" | "committed"

export type SubmissionScope = {
  viewerUserId: string
  orgId: string
  memberId: string
  propertyId: string
  assignmentEpisodeId: string
}

export type SubmissionIdentity = SubmissionScope & {
  /** The RPC route, plus ":<offerId>" for decline/accept. */
  operation: string
}

export type SubmissionRecord = SubmissionIdentity & {
  key: string
  route: string
  status: SubmissionStatus
  createdAt: number
  /** The queue version the request carried (a number, not sensitive). Lets a reload tell that the request can no longer commit. */
  expectedQueueVersion?: number | null
}

export type StoredSubmission = SubmissionRecord & {
  /** Memory only. Absent after a reload. */
  payload: Record<string, Json> | null
}

export const SUBMISSION_STORAGE_KEY = "sandra:my-leads:submissions:v1"
export const SUBMISSION_TTL_MS = 24 * 60 * 60 * 1000

const STATUSES: readonly string[] = ["fresh", "uncertain", "already-saved", "committed"]
const memory = new Map<string, StoredSubmission>()
const listeners = new Set<() => void>()

export function submissionId(identity: SubmissionIdentity): string {
  return [identity.viewerUserId, identity.orgId, identity.memberId, identity.propertyId, identity.assignmentEpisodeId, identity.operation].join("|")
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage
  } catch {
    return null
  }
}

/** The ONLY fields that ever reach sessionStorage. Everything else is dropped by construction. */
function persistable(record: SubmissionRecord): SubmissionRecord {
  return {
    viewerUserId: record.viewerUserId,
    orgId: record.orgId,
    memberId: record.memberId,
    propertyId: record.propertyId,
    assignmentEpisodeId: record.assignmentEpisodeId,
    operation: record.operation,
    key: record.key,
    route: record.route,
    status: record.status,
    createdAt: record.createdAt,
    expectedQueueVersion: typeof record.expectedQueueVersion === "number" ? record.expectedQueueVersion : null,
  }
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0

function parseRecord(value: unknown, now: number): SubmissionRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!isText(v.viewerUserId) || !isText(v.orgId) || !isText(v.memberId) || !isText(v.propertyId) || !isText(v.assignmentEpisodeId)) return null
  if (!isText(v.operation) || !isText(v.key) || !isText(v.route)) return null
  if (typeof v.status !== "string" || !STATUSES.includes(v.status)) return null
  if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt) || now - v.createdAt >= SUBMISSION_TTL_MS || v.createdAt - now > 60_000) return null
  return persistable(v as unknown as SubmissionRecord)
}

function readPersisted(now: number): SubmissionRecord[] {
  const store = storage()
  if (!store) return []
  try {
    const raw = store.getItem(SUBMISSION_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => parseRecord(item, now)).filter((item): item is SubmissionRecord => item !== null)
  } catch {
    return []
  }
}

function writePersisted(records: SubmissionRecord[]) {
  const store = storage()
  if (!store) return
  try {
    if (records.length === 0) store.removeItem(SUBMISSION_STORAGE_KEY)
    else store.setItem(SUBMISSION_STORAGE_KEY, JSON.stringify(records.map(persistable)))
  } catch {
    // Storage is full, blocked or gone: the in-memory record still protects this page.
  }
}

/** Memory wins for the same id; storage fills in what memory lost (a reload). Expired records are purged. */
function all(now: number): StoredSubmission[] {
  for (const [id, record] of memory) if (now - record.createdAt >= SUBMISSION_TTL_MS) memory.delete(id)
  const merged = new Map(memory)
  for (const record of readPersisted(now)) {
    const id = submissionId(record)
    if (!merged.has(id)) merged.set(id, { ...record, payload: null })
  }
  return [...merged.values()]
}

function sync(now: number) {
  writePersisted(all(now))
  for (const listener of listeners) listener()
}

export function getSubmission(identity: SubmissionIdentity, now = Date.now()): StoredSubmission | null {
  const id = submissionId(identity)
  return all(now).find((record) => submissionId(record) === id) ?? null
}

/** Every unexpired record for one lead, whose operation the caller accepts (e.g. both routes of an attempt). */
export function listSubmissions(scope: SubmissionScope, matches: (operation: string) => boolean, now = Date.now()): StoredSubmission[] {
  return all(now).filter((record) =>
    record.viewerUserId === scope.viewerUserId && record.orgId === scope.orgId && record.memberId === scope.memberId &&
    record.propertyId === scope.propertyId && record.assignmentEpisodeId === scope.assignmentEpisodeId && matches(record.operation))
}

/** Records for this lead under ANY assignment episode (an episode change orphans the old record). */
export function listSubmissionsAcrossEpisodes(scope: Omit<SubmissionScope, "assignmentEpisodeId">, matches: (operation: string) => boolean, now = Date.now()): StoredSubmission[] {
  return all(now).filter((record) =>
    record.viewerUserId === scope.viewerUserId && record.orgId === scope.orgId && record.memberId === scope.memberId &&
    record.propertyId === scope.propertyId && matches(record.operation))
}

export function saveSubmission(record: StoredSubmission, now = Date.now()) {
  memory.set(submissionId(record), { ...record, payload: record.payload })
  sync(now)
}

export function clearSubmission(identity: SubmissionIdentity, now = Date.now()) {
  const id = submissionId(identity)
  memory.delete(id)
  // Memory deletion alone would let the storage copy come back, so rewrite storage without it.
  writePersisted(all(now).filter((record) => submissionId(record) !== id))
  for (const listener of listeners) listener()
}

/** Sign-out: nothing of this browser session's saves survives it. */
export function clearAllSubmissions() {
  memory.clear()
  const store = storage()
  try { store?.removeItem(SUBMISSION_STORAGE_KEY) } catch { /* storage unavailable */ }
  for (const listener of listeners) listener()
}

/** Identity change: records of any other viewer or organization are discarded, not just hidden. */
export function discardOtherViewers(viewer: { userId: string; orgId: string }, now = Date.now()) {
  const keep = (record: SubmissionRecord) => record.viewerUserId === viewer.userId && record.orgId === viewer.orgId
  for (const [id, record] of memory) if (!keep(record)) memory.delete(id)
  const remaining = all(now).filter(keep)
  writePersisted(remaining)
  for (const listener of listeners) listener()
}

/** True while a save with its payload held in this page is not yet known to have committed. */
export function hasUncertainSubmission(): boolean {
  for (const record of memory.values()) if (record.status === "uncertain" && record.payload) return true
  return false
}

export function subscribeSubmissions(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Test helper: a reload clears memory and leaves sessionStorage alone. */
export function simulateReloadForTests() {
  memory.clear()
  for (const listener of listeners) listener()
}

/** Test helper: back to a clean slate, including storage. */
export function resetSubmissionStoreForTests() {
  clearAllSubmissions()
}
