// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  SUBMISSION_STORAGE_KEY, SUBMISSION_TTL_MS, clearAllSubmissions, clearSubmission, discardOtherViewers, getSubmission, hasUncertainSubmission,
  listSubmissions, resetSubmissionStoreForTests, saveSubmission, simulateReloadForTests, type StoredSubmission,
} from "./submission-store"

const record = (overrides: Partial<StoredSubmission> = {}): StoredSubmission => ({
  viewerUserId: "user-1", orgId: "org-1", memberId: "rep-A", propertyId: "prop-1", assignmentEpisodeId: "ep-1", operation: "log_attempt",
  key: "key-1", route: "log_attempt", status: "uncertain", createdAt: Date.now(), payload: null, ...overrides,
})
const scope = { viewerUserId: "user-1", orgId: "org-1", memberId: "rep-A", propertyId: "prop-1", assignmentEpisodeId: "ep-1" }
const raw = () => window.sessionStorage.getItem(SUBMISSION_STORAGE_KEY)

describe("submission store", () => {
  beforeEach(() => { resetSubmissionStoreForTests() })
  afterEach(() => { vi.restoreAllMocks() })

  it("scopes a record by viewer, org, rep, lead, episode and operation", () => {
    saveSubmission(record())
    expect(getSubmission(record())).toMatchObject({ key: "key-1" })
    for (const other of [{ viewerUserId: "user-2" }, { orgId: "org-2" }, { memberId: "rep-B" }, { propertyId: "prop-2" }, { assignmentEpisodeId: "ep-2" }, { operation: "finalize_attempt" }])
      expect(getSubmission(record(other))).toBeNull()
    expect(listSubmissions(scope, () => true)).toHaveLength(1)
    expect(listSubmissions({ ...scope, memberId: "rep-B" }, () => true)).toHaveLength(0)
  })

  it("keeps decline/accept records apart by pending offer id", () => {
    saveSubmission(record({ operation: "decline-offer:offer-1", route: "decline-offer", key: "k-a" }))
    saveSubmission(record({ operation: "decline-offer:offer-2", route: "decline-offer", key: "k-b" }))
    expect(getSubmission(record({ operation: "decline-offer:offer-1" }))?.key).toBe("k-a")
    expect(getSubmission(record({ operation: "decline-offer:offer-2" }))?.key).toBe("k-b")
  })

  it("never writes the payload or any extra field to sessionStorage (asserted on the serialized JSON)", () => {
    saveSubmission(record({
      payload: { note: "Seller said call 816-555-0100", phone: "816-555-0100", homeownerName: "Jamie Rivera", smsBody: "Hi Jamie", recordingUrl: "https://dialpad.example/rec/1", followUp: { remainder: "secret text" } },
      ...({ note: "leak", phone: "816-555-0199" } as object),
    }))
    const serialized = raw()!
    expect(Object.keys(JSON.parse(serialized)[0]).sort()).toEqual(["assignmentEpisodeId", "createdAt", "key", "memberId", "operation", "orgId", "propertyId", "route", "status", "viewerUserId"])
    for (const secret of ["816-555-0100", "816-555-0199", "Jamie", "Rivera", "secret text", "dialpad.example", "leak", "payload"]) expect(serialized).not.toContain(secret)
  })

  it("keeps the payload in memory only: a reload keeps the key and route but loses the values", () => {
    saveSubmission(record({ payload: { note: "n" } }))
    expect(getSubmission(record())?.payload).toEqual({ note: "n" })
    simulateReloadForTests()
    const after = getSubmission(record())
    expect(after).toMatchObject({ key: "key-1", route: "log_attempt", status: "uncertain" })
    expect(after?.payload).toBeNull()
  })

  it("expires persisted and in-memory records after 24 hours", () => {
    const old = Date.now() - SUBMISSION_TTL_MS - 1
    window.sessionStorage.setItem(SUBMISSION_STORAGE_KEY, JSON.stringify([{ ...record(), payload: undefined, createdAt: old }]))
    expect(getSubmission(record())).toBeNull()
    saveSubmission(record({ createdAt: Date.now() }))
    expect(getSubmission(record(), Date.now() + SUBMISSION_TTL_MS - 1_000)).not.toBeNull()
    expect(getSubmission(record(), Date.now() + SUBMISSION_TTL_MS + 1_000)).toBeNull()
  })

  it("ignores malformed, hostile or foreign-shaped storage", () => {
    for (const value of ["not json", "{}", "[1,2]", JSON.stringify([{ key: "x" }]), JSON.stringify([{ ...record(), status: "weird" }]), JSON.stringify([{ ...record(), createdAt: "now" }])]) {
      window.sessionStorage.setItem(SUBMISSION_STORAGE_KEY, value)
      expect(listSubmissions(scope, () => true)).toEqual([])
    }
  })

  it("works without storage: a throwing getItem, setItem or sessionStorage accessor never breaks the in-memory record", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota") })
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied") })
    expect(() => saveSubmission(record({ payload: { a: 1 } }))).not.toThrow()
    expect(getSubmission(record())?.payload).toEqual({ a: 1 })
    expect(() => clearSubmission(record())).not.toThrow()
    expect(getSubmission(record())).toBeNull()
    vi.restoreAllMocks()
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => { throw new Error("blocked") })
    expect(() => saveSubmission(record())).not.toThrow()
    expect(getSubmission(record())).not.toBeNull()
    expect(() => clearAllSubmissions()).not.toThrow()
  })

  it("discards records of any other viewer or organization from memory and storage", () => {
    saveSubmission(record())
    saveSubmission(record({ viewerUserId: "user-2", key: "k2" }))
    saveSubmission(record({ orgId: "org-2", key: "k3", operation: "archive", route: "archive" }))
    discardOtherViewers({ userId: "user-1", orgId: "org-1" })
    expect(JSON.parse(raw()!)).toHaveLength(1)
    expect(getSubmission(record({ viewerUserId: "user-2" }))).toBeNull()
    expect(getSubmission(record({ orgId: "org-2", operation: "archive" }))).toBeNull()
    expect(getSubmission(record())).not.toBeNull()
  })

  it("clears everything on sign-out", () => {
    saveSubmission(record())
    clearAllSubmissions()
    expect(raw()).toBeNull()
    expect(getSubmission(record())).toBeNull()
  })

  it("clearSubmission removes the storage copy too, so a reload cannot resurrect it", () => {
    saveSubmission(record())
    clearSubmission(record())
    simulateReloadForTests()
    expect(getSubmission(record())).toBeNull()
  })

  it("reports an uncertain record only while its payload is held in this page", () => {
    saveSubmission(record({ payload: { a: 1 } }))
    expect(hasUncertainSubmission()).toBe(true)
    saveSubmission(record({ status: "already-saved", payload: { a: 1 } }))
    expect(hasUncertainSubmission()).toBe(false)
    saveSubmission(record({ payload: { a: 1 } }))
    simulateReloadForTests()
    expect(hasUncertainSubmission()).toBe(false)
  })
})
