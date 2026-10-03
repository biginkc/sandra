import { StrictMode, type ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const actions = vi.hoisted(() => ({ submitMyLeadCommand: vi.fn(), submitMyLeadHandoffDrip: vi.fn() }))
vi.mock("../actions", () => ({ submitMyLeadCommand: actions.submitMyLeadCommand, submitMyLeadHandoffDrip: actions.submitMyLeadHandoffDrip }))

import type { QueueRow } from "@/lib/my-leads/queries"
import { CLOSE_CONFIRM_MESSAGE, MAY_HAVE_SAVED_MESSAGE, MAY_HAVE_SAVED_REFRESH_ONLY_MESSAGE, NEW_UPDATE_CONFIRM_MESSAGE, RESUME_NOTICE, useAttemptWorkflow, type AttemptOpening } from "./use-attempt-workflow"
import { SUBMISSION_STORAGE_KEY, getSubmission, listSubmissions, simulateReloadForTests } from "./submission-store"

const VIEWER = { userId: "user-1", orgId: "org-1" }
const row = (overrides: Partial<QueueRow> = {}) =>
  ({ propertyId: "p1", assignmentEpisodeId: "ep-1", queueVersion: 3, sharedStatus: "new_lead", address: "1 Main", offer: null, ...overrides }) as unknown as QueueRow
const opening = (action: AttemptOpening["action"] = "log-attempt", r = row()): AttemptOpening => ({ action, row: r })
const pendingOffer = (id: string) => row({ offer: { id, amountCents: 1, method: "call", sentAt: "x", followUpAt: "y", outcome: "pending" } as never })

type Props = { current: AttemptOpening | null; memberId?: string; viewer?: { userId: string; orgId: string } }
function setup(initial: AttemptOpening | null, options: { memberId?: string; viewer?: Props["viewer"]; strict?: boolean } = {}) {
  const handlers = { readRow: vi.fn(async (): Promise<QueueRow | null> => row()), onCommitted: vi.fn(async (...args: unknown[]) => { void args }), onSettled: vi.fn(), onReconciled: vi.fn(async () => undefined), onClose: vi.fn(), onDripChanged: vi.fn() }
  const wrapper = options.strict ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> : undefined
  const hook = renderHook(({ current, memberId, viewer }: Props) =>
    useAttemptWorkflow({ opening: current, memberId: memberId ?? options.memberId ?? "rep-A", viewer: viewer ?? options.viewer ?? VIEWER, ...handlers }),
  { initialProps: { current: initial } as Props, wrapper })
  return { hook, handlers }
}
const owner = () => ({ viewerUserId: "user-1", orgId: "org-1", memberId: "rep-A", propertyId: "p1", assignmentEpisodeId: "ep-1" })
const sent = (call = 0) => actions.submitMyLeadCommand.mock.calls[call][1] as Record<string, unknown>
const uncertainSave = async (hook: ReturnType<typeof setup>["hook"], payload: object = { outcome: "reached", note: "original" }) => {
  await act(async () => { await hook.result.current.submit(payload).catch(() => undefined) })
}

/**
 * A fake of the real command SQL. Receipt lookup FIRST: the same key with the same request hash
 * returns duplicate, with a different hash IDEMPOTENCY_CONFLICT. Only then the version and
 * episode checks (STALE_*), and only then the commit. It can COMMIT the original while DROPPING
 * its response ("drop"), lose it before the server ("lost"), or keep it in flight ("inflight",
 * landing later with land()).
 */
function fakeServer(start: { version: number; episode?: string; checkVersion?: boolean }) {
  const db = { version: start.version, episode: start.episode ?? "ep-1", receipts: new Map<string, string>(), commits: 0 }
  let mode: "ok" | "drop" | "lost" | "inflight" = "ok"
  const inflight: Record<string, unknown>[] = []
  const hashOf = (input: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(input).filter(([k]) => k !== "idempotencyKey").sort(([a], [b]) => a.localeCompare(b))))
  const execute = (input: Record<string, unknown>) => {
    const key = String(input.idempotencyKey)
    const hash = hashOf(input)
    const stored = db.receipts.get(key)
    if (stored !== undefined) return stored === hash ? { ok: true, duplicate: true, attemptRecorded: true } : { ok: false, answered: true, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "This was already saved. Refresh to see it." }
    if (input.expectedEpisodeId !== db.episode) return { ok: false, answered: true, certainty: "rejected", code: "STALE_ASSIGNMENT", message: "stale" }
    if (start.checkVersion !== false && input.expectedQueueVersion !== db.version) return { ok: false, answered: true, certainty: "rejected", code: "STALE_STATE", message: "stale" }
    db.receipts.set(key, hash)
    db.version += 1
    db.commits += 1
    return { ok: true, attemptRecorded: true }
  }
  const call = async (_command: string, input: Record<string, unknown>) => {
    const current = mode
    mode = "ok"
    if (current === "lost") throw new Error("network")
    if (current === "inflight") { inflight.push(input); throw new Error("network") }
    const result = execute(input)
    if (current === "drop") throw new Error("network")
    return result
  }
  return {
    db, call,
    next: (m: "drop" | "lost" | "inflight") => { mode = m },
    land: () => { for (const input of inflight.splice(0)) execute(input) },
  }
}
const typed = { outcome: "reached", source: "dialpad", note: "typed" }
const row3 = () => opening("log-attempt", row({ queueVersion: 3 }))
const rowAt = (version: number, episode = "ep-1") => opening("log-attempt", row({ queueVersion: version, assignmentEpisodeId: episode }))
const ownerScope = (episode = "ep-1") => ({ viewerUserId: "user-1", orgId: "org-1", memberId: "rep-A", propertyId: "p1", assignmentEpisodeId: episode })
const saveOnce = async (hook: ReturnType<typeof setup>["hook"], payload: object = typed) => { await act(async () => { await hook.result.current.submit(payload).catch(() => undefined) }) }

describe("submission store backs the workflow across close, unmount and reload", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    for (const fn of Object.values(actions)) fn.mockReset()
  })

  it("close then reopen while uncertain: the original values come back locked and the replay uses the same key", async () => {
    actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ ok: true, duplicate: true, attemptRecorded: true })
    const { hook } = setup(opening())
    await uncertainSave(hook)
    hook.rerender({ current: null })
    hook.rerender({ current: opening() })
    expect(hook.result.current.recoveryValue?.reconciliation).toMatchObject({ command: "log-attempt", payload: { note: "original" } })
    await act(async () => { await hook.result.current.submit({ outcome: "no_answer", note: "edited after reopen" }) })
    expect(sent(1)).toEqual(sent(0))
  })

  it("unmount and remount while uncertain resume the same record", async () => {
    actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ ok: true, duplicate: true })
    const first = setup(opening())
    await uncertainSave(first.hook)
    first.hook.unmount()
    const second = setup(opening())
    expect(second.hook.result.current.recoveryValue?.reconciliation?.payload).toMatchObject({ note: "original" })
    await act(async () => { await second.hook.result.current.submit({ outcome: "reached" }) })
    expect(sent(1)).toEqual(sent(0))
  })

  it("after a simulated reload the values are gone but the key and route are not: the form is free, the copy explains it, and the save reuses the key", async () => {
    actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ ok: true, duplicate: true, attemptRecorded: true })
    const first = setup(opening())
    await uncertainSave(first.hook, { outcome: "reached", note: "Seller said call 816-555-0100" })
    // Only non-sensitive fields reached sessionStorage.
    expect(window.sessionStorage.getItem(SUBMISSION_STORAGE_KEY)).not.toContain("816-555-0100")
    first.hook.unmount()
    simulateReloadForTests()
    const second = setup(opening())
    expect(second.hook.result.current.recoveryValue).toMatchObject({ message: RESUME_NOTICE, blocked: false, reconciliation: undefined })
    await act(async () => { await second.hook.result.current.submit({ outcome: "reached", note: "typed again" }) })
    expect(sent(1).idempotencyKey).toBe(sent(0).idempotencyKey)
    expect(sent(1).note).toBe("typed again")
  })

  it("owner switching rep A to B to A: B has no record, A's record comes back, and each rep commits exactly once (row 10)", async () => {
    const server = fakeServer({ version: 3, checkVersion: false })
    actions.submitMyLeadCommand.mockImplementation(server.call)
    server.next("drop")
    const { hook } = setup(opening(), { memberId: "rep-A" })
    await uncertainSave(hook)
    expect(server.db.commits).toBe(1)
    hook.rerender({ current: null, memberId: "rep-B" })
    hook.rerender({ current: opening(), memberId: "rep-B" })
    expect(hook.result.current.recoveryValue).toBeNull()
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    expect(sent(1).idempotencyKey).not.toBe(sent(0).idempotencyKey)
    expect(server.db.commits).toBe(2)
    hook.rerender({ current: null, memberId: "rep-A" })
    hook.rerender({ current: opening(), memberId: "rep-A" })
    expect(hook.result.current.recoveryValue?.reconciliation?.payload).toMatchObject({ note: "original", idempotencyKey: sent(0).idempotencyKey })
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    expect(sent(2)).toEqual(sent(0))
    expect(server.db.commits).toBe(2) // A's replay is a duplicate: one commit per rep
  })

  it("a different viewer neither sees nor keeps another viewer's record", async () => {
    actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network"))
    const first = setup(opening())
    await uncertainSave(first.hook)
    first.hook.unmount()
    const other = setup(opening(), { viewer: { userId: "user-2", orgId: "org-1" } })
    expect(other.hook.result.current.recoveryValue).toBeNull()
    expect(window.sessionStorage.getItem(SUBMISSION_STORAGE_KEY)).toBeNull()
    expect(listSubmissions({ viewerUserId: "user-1", orgId: "org-1", memberId: "rep-A", propertyId: "p1", assignmentEpisodeId: "ep-1" }, () => true)).toEqual([])
  })

  it("a changed assignment episode is the may-have-saved state (Refresh only), never a silent clear (row 8)", async () => {
    const server = fakeServer({ version: 3 })
    actions.submitMyLeadCommand.mockImplementation(server.call)
    server.next("drop")
    const first = setup(opening())
    await uncertainSave(first.hook)
    first.hook.unmount()
    simulateReloadForTests()
    server.db.episode = "ep-2"
    const { hook, handlers } = setup(opening("log-attempt", row({ assignmentEpisodeId: "ep-2", queueVersion: 1 })))
    expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, message: MAY_HAVE_SAVED_REFRESH_ONLY_MESSAGE })
    expect(hook.result.current.recoveryValue?.saveAsNew).toBeUndefined()
    let blocked: { ok: boolean } | undefined
    await act(async () => { blocked = await hook.result.current.submit({ outcome: "reached" }) as { ok: boolean } })
    expect(blocked?.ok).toBe(false)
    expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
    expect(listSubmissions(ownerScope(), () => true)).toHaveLength(1) // not cleared silently
    await act(async () => { hook.result.current.recoveryValue?.refresh() })
    expect(handlers.onReconciled).toHaveBeenCalledTimes(1)
    expect(handlers.onClose).toHaveBeenCalledTimes(1)
    expect(listSubmissions(ownerScope(), () => true)).toEqual([])
    expect(server.db.commits).toBe(1)
  })

  it("a changed pending offer is a different identity: offer B gets its own new key, and each offer commits exactly once (row 7)", async () => {
    const server = fakeServer({ version: 3, checkVersion: false })
    actions.submitMyLeadCommand.mockImplementation(server.call)
    server.next("drop")
    const { hook, handlers } = setup(opening("decline-offer", pendingOffer("offer-A")))
    await uncertainSave(hook, { pendingOfferId: "offer-A", note: "decline A" })
    expect(server.db.commits).toBe(1)
    expect(getSubmission({ ...ownerScope(), operation: "decline-offer:offer-A" })).toMatchObject({ status: "uncertain" })
    hook.rerender({ current: null })
    hook.rerender({ current: opening("decline-offer", pendingOffer("offer-B")) })
    expect(hook.result.current.recoveryValue).toBeNull()
    await act(async () => { await hook.result.current.submit({ pendingOfferId: "offer-B", note: "decline B" }) })
    expect(sent(1).idempotencyKey).not.toBe(sent(0).idempotencyKey)
    expect(sent(1).pendingOfferId).toBe("offer-B")
    expect(handlers.onClose).toHaveBeenCalledTimes(1)
    expect(server.db.commits).toBe(2)
    // Offer A's record is untouched: reopening A resumes A's key and its replay is a duplicate.
    hook.rerender({ current: null })
    hook.rerender({ current: opening("decline-offer", pendingOffer("offer-A")) })
    expect(hook.result.current.recoveryValue).not.toBeNull()
    await act(async () => { await hook.result.current.submit({ pendingOfferId: "offer-A" }) })
    expect(sent(2)).toEqual(sent(0))
    expect(server.db.commits).toBe(2)
  })

  it("decline records for different offers are separate subjects", async () => {
    actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network"))
    const { hook } = setup(opening("decline-offer", pendingOffer("offer-A")))
    await uncertainSave(hook, { pendingOfferId: "offer-A" })
    expect(getSubmission({ viewerUserId: "user-1", orgId: "org-1", memberId: "rep-A", propertyId: "p1", assignmentEpisodeId: "ep-1", operation: "decline-offer:offer-B" })).toBeNull()
  })

  it("a handoff record blocks switching to the drip route after a reload, and sends nothing", async () => {
    actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network"))
    const first = setup(opening("handoff"))
    await uncertainSave(first.hook, { reason: "needs_nurture", recipientUserId: "u9" })
    first.hook.unmount()
    simulateReloadForTests()
    const second = setup(opening("handoff"))
    let result: unknown
    await act(async () => { result = await second.hook.result.current.submit({ reason: "not_interested", sequenceId: "seq-1" }) })
    expect(result).toMatchObject({ ok: false, certainty: "rejected" })
    expect(actions.submitMyLeadHandoffDrip).not.toHaveBeenCalled()
    expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
  })

  it("StrictMode double effects resume once and send one request with the stored key", async () => {
    actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ ok: true, duplicate: true })
    const first = setup(opening())
    await uncertainSave(first.hook)
    first.hook.unmount()
    const second = setup(opening(), { strict: true })
    expect(second.hook.result.current.recoveryValue?.reconciliation?.payload).toMatchObject({ note: "original" })
    await act(async () => { await second.hook.result.current.submit({ outcome: "reached" }) })
    expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(2)
    expect(sent(1)).toEqual(sent(0))
  })

  it("StrictMode with no record creates nothing in storage until a send", () => {
    setup(opening(), { strict: true })
    expect(window.sessionStorage.getItem(SUBMISSION_STORAGE_KEY)).toBeNull()
  })

  it("the record is persisted BEFORE the request is sent (a reload mid-flight cannot lose the key)", async () => {
    let seenAtSend: string | null = null
    actions.submitMyLeadCommand.mockImplementationOnce(async () => { seenAtSend = window.sessionStorage.getItem(SUBMISSION_STORAGE_KEY); return { ok: true, attemptRecorded: true } })
    const { hook } = setup(opening())
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    expect(JSON.parse(seenAtSend!)[0]).toMatchObject({ status: "uncertain", key: sent(0).idempotencyKey, route: "log_attempt" })
  })

  describe("when the record is cleared", () => {
    const store = () => window.sessionStorage.getItem(SUBMISSION_STORAGE_KEY)
    it("ok on a close-after-one-save action clears it", async () => {
      actions.submitMyLeadCommand.mockResolvedValue({ ok: true })
      const { hook } = setup(opening("log-offer"))
      await act(async () => { await hook.result.current.submit({ amountCents: 1 }) })
      expect(store()).toBeNull()
    })
    it("ok on an attempt keeps a committed record until the dialog closes, then clears it", async () => {
      actions.submitMyLeadCommand.mockResolvedValue({ ok: true, attemptRecorded: true })
      const { hook } = setup(opening())
      await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
      expect(JSON.parse(store()!)[0].status).toBe("committed")
      hook.rerender({ current: null })
      expect(store()).toBeNull()
    })
    it("a committed record never resumes: the next opening is a new save with a new key", async () => {
      actions.submitMyLeadCommand.mockResolvedValue({ ok: true, attemptRecorded: true })
      const { hook } = setup(opening())
      await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
      hook.rerender({ current: null })
      hook.rerender({ current: opening() })
      expect(hook.result.current.recoveryValue).toBeNull()
      await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
      expect(sent(1).idempotencyKey).not.toBe(sent(0).idempotencyKey)
    })
    it("an uncertain record survives Cancel/close and an unmount", async () => {
      actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network"))
      const { hook } = setup(opening())
      await uncertainSave(hook)
      hook.rerender({ current: null })
      hook.unmount()
      expect(JSON.parse(store()!)[0].status).toBe("uncertain")
    })
  })

  describe("Start over", () => {
    const replayedTwice = async (second: unknown) => {
      actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(second).mockResolvedValue({ ok: true, attemptRecorded: true })
      const { hook } = setup(opening())
      await uncertainSave(hook)
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }) })
      return hook
    }
    it("is offered after a definite rejection of a frozen replay, releases the payload and keeps key and route", async () => {
      const hook = await replayedTwice({ ok: false, certainty: "rejected", message: "stale", code: "STALE_STATE" })
      expect(hook.result.current.recoveryValue).toMatchObject({ message: "Sandra can't save these values. Start over to edit them.", reconciliation: { payload: { note: "original" } } })
      act(() => hook.result.current.recoveryValue?.startOver?.())
      expect(hook.result.current.recoveryValue?.reconciliation).toBeUndefined()
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "fixed" }) })
      expect(sent(2).note).toBe("fixed")
      expect(sent(2).idempotencyKey).toBe(sent(0).idempotencyKey)
    })
    it("is offered after an answered deterministic validation code", async () => {
      const hook = await replayedTwice({ ok: false, answered: true, certainty: "unknown", code: "RECORDING_REQUIRED", message: "Attach the recording." })
      expect(hook.result.current.recoveryValue?.startOver).toBeTypeOf("function")
    })
    it.each([
      ["a transport failure", { ok: false, certainty: "unknown", message: "The update could not be confirmed. Retry with the same form." }],
      ["an answered unknown failure with no deterministic code", { ok: false, answered: true, certainty: "unknown", message: "The update could not be saved. Check the fields and retry." }],
    ])("is never offered for %s", async (_name, second) => {
      const hook = await replayedTwice(second)
      expect(hook.result.current.recoveryValue?.startOver).toBeUndefined()
      expect(hook.result.current.recoveryValue?.reconciliation?.payload).toMatchObject({ note: "original" })
    })
    it("is not offered when the payload was lost to a reload", async () => {
      actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network"))
      const first = setup(opening())
      await uncertainSave(first.hook)
      first.hook.unmount()
      simulateReloadForTests()
      const second = setup(opening())
      expect(second.hook.result.current.recoveryValue?.startOver).toBeUndefined()
    })
  })

  describe("already saved (no receipt table read)", () => {
    const conflict = { ok: false, answered: true, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "This was already saved. Refresh to see it." }
    it("a conflict drops the payload; Refresh re-reads the lead, refreshes the host, closes with no result claimed, and clears the record", async () => {
      actions.submitMyLeadCommand.mockResolvedValueOnce(conflict)
      const { hook, handlers } = setup(opening())
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "original" }) })
      // Survives close and reopen as a blocked state, and shows no values to replay.
      hook.rerender({ current: null })
      hook.rerender({ current: opening() })
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, message: "This was already saved. Refresh to see it.", reconciliation: undefined })
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
      expect(handlers.readRow).toHaveBeenCalledTimes(1)
      expect(handlers.onReconciled).toHaveBeenCalledTimes(1)
      expect(handlers.onClose).toHaveBeenCalledTimes(1)
      expect(handlers.onCommitted).not.toHaveBeenCalled()
      expect(handlers.onSettled).not.toHaveBeenCalled()
      expect(hook.result.current.recoveryValue).toBeNull()
      expect(listSubmissions(owner(), () => true)).toEqual([])
    })
    it("after a reload the same already-saved record resolves the same way", async () => {
      actions.submitMyLeadCommand.mockResolvedValueOnce(conflict)
      const first = setup(opening())
      await act(async () => { await first.hook.result.current.submit({ outcome: "reached", note: "original" }) })
      first.hook.unmount()
      simulateReloadForTests()
      const { hook, handlers } = setup(opening())
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, message: "This was already saved. Refresh to see it." })
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      expect(handlers.onClose).toHaveBeenCalledTimes(1)
      expect(handlers.onReconciled).toHaveBeenCalledTimes(1)
      expect(handlers.onCommitted).not.toHaveBeenCalled()
      expect(listSubmissions(owner(), () => true)).toEqual([])
    })
  })

  describe("may have saved (real server semantics, commits counted)", () => {
    it("row 1: reload after the original COMMITTED but its response was dropped: same key, no payload, route locked, plain re-save impossible; Refresh closes and clears; 1 commit", async () => {
      const server = fakeServer({ version: 3 })
      actions.submitMyLeadCommand.mockImplementation(server.call)
      server.next("drop")
      const first = setup(row3())
      await saveOnce(first.hook)
      expect(server.db.commits).toBe(1)
      first.hook.unmount()
      simulateReloadForTests()
      const { hook, handlers } = setup(rowAt(4))
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, message: MAY_HAVE_SAVED_MESSAGE, reconciliation: undefined })
      expect(hook.result.current.recoveryValue?.saveAsNew).toBeDefined()
      expect(getSubmission({ ...ownerScope(), operation: "log_attempt" })).toMatchObject({ status: "uncertain", key: sent(0).idempotencyKey })
      // Plain re-save is impossible, on the same route and on another one.
      await saveOnce(hook)
      await saveOnce(hook, { outcome: "reached", source: "sandra", callActivityId: "call-1" })
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      expect(handlers.onReconciled).toHaveBeenCalledTimes(1)
      expect(handlers.onClose).toHaveBeenCalledTimes(1)
      expect(handlers.onCommitted).not.toHaveBeenCalled()
      expect(listSubmissions(ownerScope(), () => true)).toEqual([])
      expect(server.db.commits).toBe(1)
    })
    it("row 1: Save as a new update asks to confirm; declining changes nothing; confirming mints a new key, lifts the route lock and saves once (2 commits, by explicit choice)", async () => {
      const server = fakeServer({ version: 3 })
      actions.submitMyLeadCommand.mockImplementation(server.call)
      server.next("drop")
      const first = setup(row3())
      await saveOnce(first.hook)
      first.hook.unmount()
      simulateReloadForTests()
      const { hook } = setup(rowAt(4))
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
      act(() => hook.result.current.recoveryValue?.saveAsNew?.())
      expect(confirm).toHaveBeenCalledWith(NEW_UPDATE_CONFIRM_MESSAGE)
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true })
      expect(server.db.commits).toBe(1)
      confirm.mockReturnValue(true)
      act(() => hook.result.current.recoveryValue?.saveAsNew?.())
      expect(hook.result.current.recoveryValue).toBeNull()
      await saveOnce(hook, { outcome: "reached", source: "sandra", callActivityId: "call-1" })
      expect(sent(1).idempotencyKey).not.toBe(sent(0).idempotencyKey)
      expect(server.db.commits).toBe(2)
    })
    it("row 2: reload when the original never reached the server (version unchanged): same key, resume notice, Save allowed, 1 commit", async () => {
      const server = fakeServer({ version: 3 })
      actions.submitMyLeadCommand.mockImplementation(server.call)
      server.next("lost")
      const first = setup(row3())
      await saveOnce(first.hook)
      expect(server.db.commits).toBe(0)
      first.hook.unmount()
      simulateReloadForTests()
      const { hook } = setup(row3())
      expect(hook.result.current.recoveryValue).toMatchObject({ message: RESUME_NOTICE, blocked: false })
      await saveOnce(hook)
      expect(sent(1).idempotencyKey).toBe(sent(0).idempotencyKey)
      expect(server.db.commits).toBe(1)
    })
    it("row 2: a different route is refused, and Save as a new update (confirm) is the way out: new key, lock lifted, 1 commit", async () => {
      const server = fakeServer({ version: 3 })
      actions.submitMyLeadCommand.mockImplementation(server.call)
      server.next("lost")
      const first = setup(row3())
      await saveOnce(first.hook)
      first.hook.unmount()
      simulateReloadForTests()
      const { hook } = setup(row3())
      const other = { outcome: "reached", source: "sandra", callActivityId: "call-1" }
      let refused: { ok: boolean; message?: string } | undefined
      await act(async () => { refused = await hook.result.current.submit(other) as { ok: boolean; message?: string } })
      expect(refused).toMatchObject({ ok: false })
      expect(refused?.message).toMatch(/different kind of update/)
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
      expect(hook.result.current.recoveryValue?.saveAsNew).toBeDefined()
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
      act(() => hook.result.current.recoveryValue?.saveAsNew?.())
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
      confirm.mockReturnValue(true)
      act(() => hook.result.current.recoveryValue?.saveAsNew?.())
      await saveOnce(hook, other)
      expect(sent(1).idempotencyKey).not.toBe(sent(0).idempotencyKey)
      expect(sent(1)).toMatchObject({ source: "sandra" })
      expect(server.db.commits).toBe(1)
    })
    it("row 3: reload while the original is still in flight: the same key, so the re-save is a duplicate or a conflict, never a second commit", async () => {
      for (const payload of [typed, { ...typed, note: "typed differently" }]) {
        window.sessionStorage.clear()
        simulateReloadForTests()
        actions.submitMyLeadCommand.mockReset()
        const server = fakeServer({ version: 3 })
        actions.submitMyLeadCommand.mockImplementation(server.call)
        server.next("inflight")
        const first = setup(row3())
        await saveOnce(first.hook)
        first.hook.unmount()
        simulateReloadForTests()
        const { hook } = setup(row3())
        server.land() // the original commits while the rep re-saves
        await saveOnce(hook, payload)
        expect(sent(1).idempotencyKey).toBe(sent(0).idempotencyKey)
        expect(server.db.commits).toBe(1)
      }
    })
    it("row 4a: in-session timeout, original committed: Reconcile replays the identical request, duplicate, saved with the real result; 1 commit", async () => {
      const server = fakeServer({ version: 3 })
      actions.submitMyLeadCommand.mockImplementation(server.call)
      server.next("drop")
      const { hook, handlers } = setup(row3())
      await saveOnce(hook)
      expect(hook.result.current.recoveryValue?.reconciliation).toBeDefined()
      await saveOnce(hook, { ...typed, note: "edited" })
      expect(sent(1)).toEqual(sent(0))
      expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
      expect(handlers.onCommitted.mock.calls[0][0]).toMatchObject({ result: { duplicate: true } })
      expect(server.db.commits).toBe(1)
    })
    it("row 4b: in-session timeout, ANOTHER writer moved the version: the replay is STALE (proof), Start over, then the edited save commits: 0 then 1", async () => {
      const server = fakeServer({ version: 3 })
      actions.submitMyLeadCommand.mockImplementation(server.call)
      server.next("lost")
      const handlers = setup(row3())
      const hook = handlers.hook
      await saveOnce(hook)
      server.db.version = 4 // another writer
      await saveOnce(hook) // frozen replay: STALE
      expect(hook.result.current.recoveryValue?.startOver).toBeDefined()
      expect(server.db.commits).toBe(0)
      handlers.handlers.readRow.mockResolvedValue(row({ queueVersion: 4 }))
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      act(() => hook.result.current.recoveryValue?.startOver?.())
      await saveOnce(hook, { ...typed, note: "edited" })
      expect(sent(2).idempotencyKey).toBe(sent(0).idempotencyKey)
      expect(sent(2)).toMatchObject({ note: "edited", expectedQueueVersion: 4 })
      expect(server.db.commits).toBe(1)
    })
    it("row 5 and 9b: a duplicated tab copies the key; the original tab committed; the duplicate's edited save conflicts, its Refresh closes and clears; 1 commit", async () => {
      const server = fakeServer({ version: 3 })
      actions.submitMyLeadCommand.mockImplementation(server.call)
      server.next("drop")
      const tab1 = setup(row3())
      await saveOnce(tab1.hook)
      expect(server.db.commits).toBe(1)
      tab1.hook.unmount()
      simulateReloadForTests() // the duplicate has the copied storage and no memory
      const { hook, handlers } = setup(row3()) // its page still shows the version it loaded
      await saveOnce(hook, { ...typed, note: "different text" })
      expect(sent(1).idempotencyKey).toBe(sent(0).idempotencyKey)
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, message: "This was already saved. Refresh to see it.", reconciliation: undefined })
      expect(hook.result.current.recoveryValue?.saveAsNew).toBeUndefined()
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      expect(handlers.onClose).toHaveBeenCalledTimes(1)
      expect(listSubmissions(ownerScope(), () => true)).toEqual([])
      expect(server.db.commits).toBe(1)
    })
    it("row 9b: a duplicated tab re-saving the identical request gets a duplicate; 1 commit", async () => {
      const server = fakeServer({ version: 3 })
      actions.submitMyLeadCommand.mockImplementation(server.call)
      server.next("drop")
      const tab1 = setup(row3())
      await saveOnce(tab1.hook)
      tab1.hook.unmount()
      simulateReloadForTests()
      const { hook, handlers } = setup(row3())
      await saveOnce(hook)
      expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
      expect(server.db.commits).toBe(1)
    })
    it("row 9a: two separate tabs use separate keys; one commits, the other is STALE; 1 commit", async () => {
      const server = fakeServer({ version: 3 })
      actions.submitMyLeadCommand.mockImplementation(server.call)
      const tab1 = setup(row3())
      await saveOnce(tab1.hook)
      tab1.hook.unmount()
      window.sessionStorage.clear() // another tab has its own sessionStorage
      simulateReloadForTests()
      const tab2 = setup(row3())
      await saveOnce(tab2.hook, { ...typed, note: "tab two" })
      expect(sent(1).idempotencyKey).not.toBe(sent(0).idempotencyKey)
      expect(server.db.commits).toBe(1)
    })
    it("row 8: the lead left the queue after a reload: Refresh shows Refresh-only, then closes and clears; 1 commit", async () => {
      const server = fakeServer({ version: 3 })
      actions.submitMyLeadCommand.mockImplementation(server.call)
      server.next("inflight")
      const first = setup(row3())
      await saveOnce(first.hook)
      first.hook.unmount()
      simulateReloadForTests()
      server.land()
      const { hook, handlers } = setup(row3())
      handlers.readRow.mockResolvedValue(null)
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, message: MAY_HAVE_SAVED_REFRESH_ONLY_MESSAGE })
      expect(hook.result.current.recoveryValue?.saveAsNew).toBeUndefined()
      expect(handlers.onClose).not.toHaveBeenCalled()
      expect(listSubmissions(ownerScope(), () => true)).toHaveLength(1) // not cleared silently
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      expect(handlers.onClose).toHaveBeenCalledTimes(1)
      expect(listSubmissions(ownerScope(), () => true)).toEqual([])
      expect(server.db.commits).toBe(1)
    })
    it("row 6: after STALE proof and Start over the edited save commits once on the same key; the late original then CONFLICTS; a route switch after STALE proof takes a new key; 1 commit per saved request", async () => {
      const server = fakeServer({ version: 3 })
      actions.submitMyLeadCommand.mockImplementation(server.call)
      server.next("inflight")
      const { hook, handlers } = setup(row3())
      await saveOnce(hook)
      server.db.version = 4 // another writer
      await saveOnce(hook) // frozen replay: STALE proof
      handlers.readRow.mockResolvedValue(row({ queueVersion: 4 }))
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      act(() => hook.result.current.recoveryValue?.startOver?.())
      await saveOnce(hook, { ...typed, note: "edited" })
      expect(sent(2).idempotencyKey).toBe(sent(0).idempotencyKey)
      expect(server.db.commits).toBe(1)
      server.land() // the late original: same key, different request
      expect(server.db.commits).toBe(1)
    })
    it("row 6: a route switch after STALE proof mints a new key and saves once", async () => {
      const server = fakeServer({ version: 3 })
      actions.submitMyLeadCommand.mockImplementation(server.call)
      server.next("lost")
      const { hook, handlers } = setup(row3())
      await saveOnce(hook)
      server.db.version = 4
      await saveOnce(hook) // STALE proof
      handlers.readRow.mockResolvedValue(row({ queueVersion: 4 }))
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      act(() => hook.result.current.recoveryValue?.startOver?.())
      await saveOnce(hook, { outcome: "reached", source: "sandra", callActivityId: "call-1" })
      expect(sent(2).idempotencyKey).not.toBe(sent(0).idempotencyKey)
      expect(server.db.commits).toBe(1)
    })
    it("row 11 (accepted risk): after 24 hours the record expires, so a re-save is a new key and a clean form; if the original had committed that is a second commit", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      try {
        const server = fakeServer({ version: 3 })
        actions.submitMyLeadCommand.mockImplementation(server.call)
        server.next("drop")
        const first = setup(row3())
        await saveOnce(first.hook)
        first.hook.unmount()
        simulateReloadForTests()
        vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
        const { hook } = setup(rowAt(4))
        expect(hook.result.current.recoveryValue).toBeNull()
        await saveOnce(hook)
        expect(sent(1).idempotencyKey).not.toBe(sent(0).idempotencyKey)
        expect(server.db.commits).toBe(2)
      } finally { vi.useRealTimers() }
    })
  })

  describe("close confirmation", () => {
    it("asks only for a user-initiated close while uncertain or already saved", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
      actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network"))
      const { hook } = setup(opening())
      expect(hook.result.current.confirmClose()).toBe(true)
      expect(confirm).not.toHaveBeenCalled()
      await uncertainSave(hook)
      expect(hook.result.current.confirmClose()).toBe(false)
      expect(confirm).toHaveBeenCalledWith(CLOSE_CONFIRM_MESSAGE)
      confirm.mockReturnValue(true)
      expect(hook.result.current.confirmClose()).toBe(true)
    })
    it("asks when already saved, but not after a confirmed save", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true)
      actions.submitMyLeadCommand.mockResolvedValueOnce({ ok: false, answered: true, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "saved" }).mockResolvedValueOnce({ ok: true, duplicate: true })
      const { hook } = setup(opening("log-offer"))
      await act(async () => { await hook.result.current.submit({ amountCents: 1 }) })
      hook.result.current.confirmClose()
      expect(confirm).toHaveBeenCalledTimes(1)
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      hook.result.current.confirmClose()
      expect(confirm).toHaveBeenCalledTimes(1)
    })
    it("does not ask for the resumed no-payload state (nothing is lost by closing it)", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
      actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network"))
      const first = setup(opening())
      await uncertainSave(first.hook)
      first.hook.unmount()
      simulateReloadForTests()
      const second = setup(opening())
      expect(second.hook.result.current.confirmClose()).toBe(true)
      expect(confirm).not.toHaveBeenCalled()
    })
  })

  describe("beforeunload warning", () => {
    it("is registered while a save is uncertain and removed once it is resolved", async () => {
      const add = vi.spyOn(window, "addEventListener")
      const remove = vi.spyOn(window, "removeEventListener")
      actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ ok: true, duplicate: true })
      const { hook } = setup(opening("log-offer"))
      await uncertainSave(hook, { amountCents: 1 })
      expect(add.mock.calls.some(([type]) => type === "beforeunload")).toBe(true)
      const handler = add.mock.calls.find(([type]) => type === "beforeunload")![1] as (event: BeforeUnloadEvent) => void
      const event = { preventDefault: vi.fn(), returnValue: undefined as unknown } as unknown as BeforeUnloadEvent
      handler(event)
      expect(event.preventDefault).toHaveBeenCalled()
      await act(async () => { await hook.result.current.submit({ amountCents: 1 }) })
      expect(remove.mock.calls.some(([type]) => type === "beforeunload")).toBe(true)
    })
  })
})
