import { StrictMode, type ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const actions = vi.hoisted(() => ({ submitMyLeadCommand: vi.fn(), submitMyLeadHandoffDrip: vi.fn(), loadMyLeadCommandReceipt: vi.fn() }))
vi.mock("../actions", () => ({ submitMyLeadCommand: actions.submitMyLeadCommand, submitMyLeadHandoffDrip: actions.submitMyLeadHandoffDrip, loadMyLeadCommandReceipt: actions.loadMyLeadCommandReceipt }))

import type { QueueRow } from "@/lib/my-leads/queries"
import { CLOSE_CONFIRM_MESSAGE, RESUME_NOTICE, useAttemptWorkflow, type AttemptOpening } from "./use-attempt-workflow"
import { SUBMISSION_STORAGE_KEY, getSubmission, listSubmissions, simulateReloadForTests } from "./submission-store"

const VIEWER = { userId: "user-1", orgId: "org-1" }
const row = (overrides: Partial<QueueRow> = {}) =>
  ({ propertyId: "p1", assignmentEpisodeId: "ep-1", queueVersion: 3, sharedStatus: "new_lead", address: "1 Main", offer: null, ...overrides }) as unknown as QueueRow
const opening = (action: AttemptOpening["action"] = "log-attempt", r = row()): AttemptOpening => ({ action, row: r })
const pendingOffer = (id: string) => row({ offer: { id, amountCents: 1, method: "call", sentAt: "x", followUpAt: "y", outcome: "pending" } as never })

type Props = { current: AttemptOpening | null; memberId?: string; viewer?: { userId: string; orgId: string } }
function setup(initial: AttemptOpening | null, options: { memberId?: string; viewer?: Props["viewer"]; strict?: boolean } = {}) {
  const handlers = { readRow: vi.fn(async (): Promise<QueueRow | null> => row()), onCommitted: vi.fn(async () => undefined), onSettled: vi.fn(), onClose: vi.fn(), onDripChanged: vi.fn() }
  const wrapper = options.strict ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> : undefined
  const hook = renderHook(({ current, memberId, viewer }: Props) =>
    useAttemptWorkflow({ opening: current, memberId: memberId ?? options.memberId ?? "rep-A", viewer: viewer ?? options.viewer ?? VIEWER, ...handlers }),
  { initialProps: { current: initial } as Props, wrapper })
  return { hook, handlers }
}
const sent = (call = 0) => actions.submitMyLeadCommand.mock.calls[call][1] as Record<string, unknown>
const uncertainSave = async (hook: ReturnType<typeof setup>["hook"], payload: object = { outcome: "reached", note: "original" }) => {
  await act(async () => { await hook.result.current.submit(payload).catch(() => undefined) })
}

describe("submission store backs the workflow across close, unmount and reload", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    for (const fn of Object.values(actions)) fn.mockReset()
    actions.loadMyLeadCommandReceipt.mockResolvedValue({ ok: true, receipt: { operation: "log_acquisition_attempt", propertyId: "p1", episodeId: "ep-1", attemptRecorded: true, followUp: null } })
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

  it("owner switching rep A to B to A: B has no record, A's record comes back", async () => {
    actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network")).mockResolvedValue({ ok: false, certainty: "rejected", message: "Pick an outcome." })
    const { hook } = setup(opening(), { memberId: "rep-A" })
    await uncertainSave(hook)
    hook.rerender({ current: null, memberId: "rep-B" })
    hook.rerender({ current: opening(), memberId: "rep-B" })
    expect(hook.result.current.recoveryValue).toBeNull()
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    expect(sent(1).idempotencyKey).not.toBe(sent(0).idempotencyKey)
    hook.rerender({ current: null, memberId: "rep-A" })
    hook.rerender({ current: opening(), memberId: "rep-A" })
    expect(hook.result.current.recoveryValue?.reconciliation?.payload).toMatchObject({ note: "original", idempotencyKey: sent(0).idempotencyKey })
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

  it("a changed assignment episode does not resume the old record", async () => {
    actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ ok: false, certainty: "rejected", message: "x" })
    const { hook } = setup(opening())
    await uncertainSave(hook)
    hook.rerender({ current: null })
    hook.rerender({ current: opening("log-attempt", row({ assignmentEpisodeId: "ep-2" })) })
    expect(hook.result.current.recoveryValue).toBeNull()
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    expect(sent(1).idempotencyKey).not.toBe(sent(0).idempotencyKey)
    expect(sent(1).expectedEpisodeId).toBe("ep-2")
  })

  it("a changed pending offer keeps the key but drops the payload", async () => {
    actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ ok: true })
    const { hook } = setup(opening("decline-offer", pendingOffer("offer-A")))
    await uncertainSave(hook, { pendingOfferId: "offer-A", note: "decline A" })
    expect(getSubmission({ viewerUserId: "user-1", orgId: "org-1", memberId: "rep-A", propertyId: "p1", assignmentEpisodeId: "ep-1", operation: "decline-offer:offer-A" })).toMatchObject({ status: "uncertain" })
    hook.rerender({ current: null })
    hook.rerender({ current: opening("decline-offer", pendingOffer("offer-B")) })
    expect(hook.result.current.recoveryValue).toMatchObject({ message: RESUME_NOTICE, reconciliation: undefined })
    await act(async () => { await hook.result.current.submit({ pendingOfferId: "offer-B", note: "decline B" }) })
    expect(sent(1).idempotencyKey).toBe(sent(0).idempotencyKey)
    expect(sent(1).pendingOfferId).toBe("offer-B")
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

  describe("verified Saved earlier", () => {
    const conflict = { ok: false, answered: true, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "This was already saved. Refresh to see it." }
    it("already-saved survives close and reopen as a blocked state, and Refresh verifies the receipt with the scoped lookup", async () => {
      actions.submitMyLeadCommand.mockResolvedValue(conflict)
      const { hook, handlers } = setup(opening())
      await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
      hook.rerender({ current: null })
      hook.rerender({ current: opening() })
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, message: "This was already saved. Refresh to see it." })
      actions.loadMyLeadCommandReceipt.mockResolvedValue({ ok: true, receipt: { operation: "log_acquisition_attempt", propertyId: "p1", episodeId: "ep-1", attemptRecorded: true, followUp: { status: "delivered" } } })
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      expect(actions.loadMyLeadCommandReceipt).toHaveBeenCalledWith({ idempotencyKey: sent(0).idempotencyKey, operation: "log_acquisition_attempt", propertyId: "p1", episodeId: "ep-1" })
      expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
      expect(hook.result.current.recoveryValue?.message).toBe("Saved earlier. Your update is recorded. Follow-up text status: delivered.")
      // No retry: the next Save sends nothing and carries the verified follow-up status.
      let moved: unknown
      await act(async () => { moved = await hook.result.current.submit({ outcome: "reached" }) })
      expect(moved).toMatchObject({ ok: true, attemptRecorded: true, followUp: { status: "delivered" } })
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
    })
    it.each([
      ["a missing receipt", { ok: false, code: "NOT_FOUND", message: "Sandra could not find the earlier save yet. Try Refresh again." }],
      ["a denied or failed lookup", { ok: false, code: "FORBIDDEN", message: "Could not check the earlier save. Try Refresh again." }],
    ])("%s stays blocked with a retryable message and never fakes success", async (_name, lookup) => {
      actions.submitMyLeadCommand.mockResolvedValue(conflict)
      actions.loadMyLeadCommandReceipt.mockResolvedValue(lookup)
      const { hook, handlers } = setup(opening("log-offer"))
      await act(async () => { await hook.result.current.submit({ amountCents: 1 }) })
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, busy: false, message: (lookup as { message: string }).message })
      expect(handlers.onCommitted).not.toHaveBeenCalled()
      expect(handlers.onClose).not.toHaveBeenCalled()
    })
    it("a lookup that throws stays blocked and retryable", async () => {
      actions.submitMyLeadCommand.mockResolvedValue(conflict)
      actions.loadMyLeadCommandReceipt.mockRejectedValueOnce(new Error("down"))
      const { hook, handlers } = setup(opening("log-offer"))
      await act(async () => { await hook.result.current.submit({ amountCents: 1 }) })
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, busy: false })
      expect(handlers.onCommitted).not.toHaveBeenCalled()
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
      actions.submitMyLeadCommand.mockResolvedValueOnce({ ok: false, answered: true, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "saved" })
      const { hook } = setup(opening())
      await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
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
