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
  /** Memory only: the record's revision. Absent (0) for a record restored from storage. */
  rev?: number
}

/**
 * Write authority over one record. Claims come from user actions (Save, Start over, Save as a new
 * update, Refresh-and-close); conditional writes come from async results and only succeed while the
 * store epoch, the record's owner tag and its revision are all still the lease's. A sign-out, a
 * viewer change or another instance's claim therefore makes every older writer's late answer a no-op.
 */
export type Lease = { epoch: number; rev: number; tag: string; id: string }

export const SUBMISSION_STORAGE_KEY = "sandra:my-leads:submissions:v1"
export const SUBMISSION_TTL_MS = 24 * 60 * 60 * 1000

const STATUSES: readonly string[] = ["fresh", "uncertain", "already-saved", "committed"]
const memory = new Map<string, StoredSubmission>()
/** Memory only (never in sessionStorage): per-record revision and owner tag. */
const meta = new Map<string, { rev: number; owner: string }>()
/** Memory only: how many sends were ever made under a key in this page. */
const sendCounts = new Map<string, number>()
let epoch = 0
let currentViewer: { userId: string; orgId: string } | null = null
let inflightSends = 0
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
  return [...merged.values()].map((record) => ({ ...record, rev: meta.get(submissionId(record))?.rev ?? 0 }))
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
  epoch += 1
  currentViewer = null
  memory.clear()
  meta.clear()
  const store = storage()
  try { store?.removeItem(SUBMISSION_STORAGE_KEY) } catch { /* storage unavailable */ }
  for (const listener of listeners) listener()
}

/** Identity change: records of any other viewer or organization are discarded, not just hidden. */
export function discardOtherViewers(viewer: { userId: string; orgId: string }, now = Date.now()) {
  // Only a purge that CHANGES the viewer bumps the epoch. The same viewer again is a no-op, so two
  // hosts of the same viewer (My Leads and the lead page) never knock out each other's pending saves.
  if (currentViewer && (currentViewer.userId !== viewer.userId || currentViewer.orgId !== viewer.orgId)) epoch += 1
  currentViewer = { userId: viewer.userId, orgId: viewer.orgId }
  const keep = (record: SubmissionRecord) => record.viewerUserId === viewer.userId && record.orgId === viewer.orgId
  for (const [id, record] of memory) if (!keep(record)) { memory.delete(id); meta.delete(id) }
  const remaining = all(now).filter(keep)
  writePersisted(remaining)
  for (const listener of listeners) listener()
}

export function getEpoch(): number { return epoch }

const unresolved = (record: { status: SubmissionStatus }) => record.status === "uncertain" || record.status === "already-saved"
const leaseFor = (id: string, tag: string): Lease => ({ epoch, rev: meta.get(id)?.rev ?? 0, tag, id })

/**
 * CLAIM (user action). Succeeds only in the epoch the caller read, and never changes the key of an
 * unresolved record unless `replaceKey` is set (an explicit "Save as a new update" or a proven
 * route change): taking over a record keeps its key, so a takeover can never mint a second commit.
 */
export function claimSubmission(record: StoredSubmission, tag: string, options: { epoch: number; send?: boolean; replaceKey?: boolean; expectRev?: number }, now = Date.now()): Lease | null {
  if (options.epoch !== epoch) return null
  const id = submissionId(record)
  const existing = all(now).find((item) => submissionId(item) === id)
  // Compare-and-set: the record must still be at the revision the caller last read.
  if (options.expectRev !== undefined && (existing?.rev ?? 0) !== options.expectRev) return null
  if (existing && existing.key !== record.key && unresolved(existing) && !options.replaceKey) return null
  meta.set(id, { rev: (meta.get(id)?.rev ?? existing?.rev ?? 0) + 1, owner: tag })
  memory.set(id, { ...record, payload: record.payload, rev: undefined })
  if (options.send) sendCounts.set(record.key, (sendCounts.get(record.key) ?? 0) + 1)
  sync(now)
  return leaseFor(id, tag)
}

/**
 * CONDITIONAL WRITE (async result). Only while the epoch, the owner tag and the revision are all the
 * lease's. A record may return to "fresh" only when its key was sent exactly once in this page: the
 * one send whose definite rejection proves nothing committed.
 */
export function writeSubmission(lease: Lease, record: StoredSubmission, now = Date.now()): Lease | null {
  const held = meta.get(lease.id)
  if (lease.epoch !== epoch || !held || held.owner !== lease.tag || held.rev !== lease.rev || submissionId(record) !== lease.id) return null
  if (record.status === "fresh" && (sendCounts.get(record.key) ?? 0) !== 1) return null
  meta.set(lease.id, { rev: held.rev + 1, owner: lease.tag })
  memory.set(lease.id, { ...record, payload: record.payload, rev: undefined })
  // The key's only send was definitely rejected: the next send under it is again "the only one".
  if (record.status === "fresh") sendCounts.set(record.key, 0)
  sync(now)
  return leaseFor(lease.id, lease.tag)
}

/** Conditional clear (async cleanup). Afterwards the lease is dead, so nothing can resurrect the record. */
export function clearWithLease(lease: Lease, now = Date.now()): boolean {
  const held = meta.get(lease.id)
  if (lease.epoch !== epoch || !held || held.owner !== lease.tag || held.rev !== lease.rev) return false
  memory.delete(lease.id)
  meta.delete(lease.id)
  writePersisted(all(now).filter((item) => submissionId(item) !== lease.id))
  for (const listener of listeners) listener()
  return true
}

/** Claimed clear (user action): removes the record when it still carries `expectKey` (or is gone). */
export function claimClear(identity: SubmissionIdentity, options: { epoch: number; expectKey: string | null; expectRev?: number }, now = Date.now()): boolean {
  if (options.epoch !== epoch) return false
  const id = submissionId(identity)
  const existing = all(now).find((item) => submissionId(item) === id)
  if (options.expectRev !== undefined && (existing?.rev ?? 0) !== options.expectRev) return false
  if (existing && options.expectKey !== null && existing.key !== options.expectKey) return false
  memory.delete(id)
  meta.delete(id)
  writePersisted(all(now).filter((item) => submissionId(item) !== id))
  for (const listener of listeners) listener()
  return true
}

export function beginSend() { inflightSends += 1 }
export function endSend() { inflightSends = Math.max(0, inflightSends - 1) }
/** A save is in flight or an uncertain one is held in this page: signing out would drop its protection. */
export function hasPendingSave(): boolean {
  if (inflightSends > 0) return true
  for (const record of memory.values()) if (record.status === "uncertain") return true
  return false
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
  meta.clear()
  sendCounts.clear()
  epoch += 1 // a reload leaves no old writer alive
  currentViewer = null
  inflightSends = 0
  for (const listener of listeners) listener()
}

/** Test helper: back to a clean slate, including storage. */
export function resetSubmissionStoreForTests() {
  clearAllSubmissions()
}
