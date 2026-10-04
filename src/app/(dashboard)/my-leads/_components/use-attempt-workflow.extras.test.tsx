import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const actions = vi.hoisted(() => ({ submitMyLeadCommand: vi.fn(), submitMyLeadHandoffDrip: vi.fn() }))
vi.mock("../actions", () => ({ submitMyLeadCommand: actions.submitMyLeadCommand, submitMyLeadHandoffDrip: actions.submitMyLeadHandoffDrip }))

import type { QueueRow } from "@/lib/my-leads/queries"
import { EXTRAS_STORAGE_KEY, clearExtras, getExtras, resetExtrasStoreForTests, simulateExtrasReloadForTests } from "./extras-store"
import { simulateReloadForTests, resetSubmissionStoreForTests } from "./submission-store"
import { useAttemptWorkflow, type AttemptOpening } from "./use-attempt-workflow"

/**
 * Every recovery path that proves the attempt is saved must hand the note and next step to the host,
 * keyed by the attempt's idempotency key, so a note is never silently dropped.
 */
const VIEWER = { userId: "user-1", orgId: "org-1" }
const row = (queueVersion = 3) => ({ propertyId: "p1", assignmentEpisodeId: "ep-1", queueVersion, sharedStatus: "new_lead", address: "1 Main" }) as unknown as QueueRow
const opening = (version = 3): AttemptOpening => ({ action: "log-attempt", row: row(version) })
const extras = (note = "Seller wants 120k") => ({ submissionId: "11111111-1111-4111-8111-111111111111", note, nextStep: { pick: "tomorrow" as const, dueAt: "2026-10-06T15:00:00.000Z" } })

function setup(initial: AttemptOpening | null) {
  const handlers = {
    readRow: vi.fn(async (): Promise<QueueRow | null> => row()),
    onCommitted: vi.fn(async (...args: unknown[]) => { void args }),
    onExtras: vi.fn(),
    onSettled: vi.fn(),
    onReconciled: vi.fn(async () => undefined),
    onClose: vi.fn(),
    onDripChanged: vi.fn(),
  }
  const hook = renderHook(({ current }: { current: AttemptOpening | null }) =>
    useAttemptWorkflow({ opening: current, memberId: "rep-1", viewer: VIEWER, ...handlers }), { initialProps: { current: initial } })
  return { hook, handlers }
}
const gateOf = () => { let open: () => void = () => undefined; const promise = new Promise<void>((resolve) => { open = resolve }); return { promise, open } }

describe("post-call extras on every recovery path", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    resetExtrasStoreForTests()
    resetSubmissionStoreForTests()
    actions.submitMyLeadCommand.mockReset()
  })

  it("registers the extras with the attempt's key before sending, and keeps them in sessionStorage", async () => {
    actions.submitMyLeadCommand.mockRejectedValue(new Error("network"))
    const { hook } = setup(opening())
    await act(async () => { await hook.result.current.submit({ outcome: "reached", postCall: extras() }).catch(() => undefined) })
    const key = (actions.submitMyLeadCommand.mock.calls[0][1] as { idempotencyKey: string }).idempotencyKey
    expect(getExtras("user-1", key)?.extras).toMatchObject({ note: "Seller wants 120k" })
    expect(window.sessionStorage.getItem(EXTRAS_STORAGE_KEY)).toContain(key)
  })

  it("late success after the prompt closed: the extras are handed to the host exactly once", async () => {
    const gate = gateOf()
    actions.submitMyLeadCommand.mockImplementation(async () => { await gate.promise; return { ok: true, attemptRecorded: true } })
    const { hook, handlers } = setup(opening())
    let pending: Promise<unknown> = Promise.resolve()
    act(() => { pending = hook.result.current.submit({ outcome: "voicemail", postCall: extras() }).catch(() => undefined) })
    hook.unmount()
    gate.open()
    await act(async () => { await pending })
    expect(handlers.onCommitted).not.toHaveBeenCalled()
    expect(handlers.onExtras).toHaveBeenCalledTimes(1)
    const key = (actions.submitMyLeadCommand.mock.calls[0][1] as { idempotencyKey: string }).idempotencyKey
    expect(handlers.onExtras.mock.calls[0][0]).toMatchObject({ attemptKey: key, propertyId: "p1", memberId: "rep-1", extras: { note: "Seller wants 120k", submissionId: extras().submissionId } })
  })

  it("already saved (receipt exists): the extras are handed to the host exactly once", async () => {
    actions.submitMyLeadCommand.mockResolvedValue({ ok: false, answered: true, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "This was already saved. Refresh to see it." })
    const { hook, handlers } = setup(opening())
    await act(async () => { await hook.result.current.submit({ outcome: "reached", postCall: extras() }) })
    expect(handlers.onExtras).toHaveBeenCalledTimes(1)
    expect(handlers.onExtras.mock.calls[0][0].extras.note).toBe("Seller wants 120k")
    // Blocked afterwards: a second submit neither re-sends nor re-flushes.
    await act(async () => { await hook.result.current.submit({ outcome: "reached", postCall: extras("edited") }) })
    expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
    expect(handlers.onExtras).toHaveBeenCalledTimes(1)
  })

  it("Refresh-and-close after a reload mid-save: the extras come back from sessionStorage and are flushed", async () => {
    actions.submitMyLeadCommand.mockRejectedValue(new Error("network"))
    const first = setup(opening(3))
    await act(async () => { await first.hook.result.current.submit({ outcome: "reached", postCall: extras() }).catch(() => undefined) })
    first.hook.unmount()
    // A reload clears memory (including the payload); the queue has moved on, so the save may have gone through.
    simulateReloadForTests()
    simulateExtrasReloadForTests()
    const second = setup(opening(4))
    expect(second.hook.result.current.recoveryValue?.saveAsNew).toBeTruthy()
    expect(second.handlers.onExtras).not.toHaveBeenCalled()
    await act(async () => { second.hook.result.current.recoveryValue?.refresh() })
    expect(second.handlers.onClose).toHaveBeenCalledTimes(1)
    expect(second.handlers.onExtras).toHaveBeenCalledTimes(1)
    expect(second.handlers.onExtras.mock.calls[0][0].extras).toMatchObject({ note: "Seller wants 120k" })
  })

  it("a normal committed save hands the extras to onCommitted (with the attempt key), not onExtras", async () => {
    actions.submitMyLeadCommand.mockResolvedValue({ ok: true, attemptRecorded: true })
    const { hook, handlers } = setup(opening())
    await act(async () => { await hook.result.current.submit({ outcome: "reached", postCall: extras() }) })
    const key = (actions.submitMyLeadCommand.mock.calls[0][1] as { idempotencyKey: string }).idempotencyKey
    expect(handlers.onCommitted.mock.calls[0][0]).toMatchObject({ attemptKey: key, extras: { note: "Seller wants 120k" } })
    expect(handlers.onExtras).not.toHaveBeenCalled()
  })

  it("an attempt with no extras never calls onExtras on any path", async () => {
    actions.submitMyLeadCommand.mockResolvedValue({ ok: false, answered: true, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "dup" })
    const { hook, handlers } = setup(opening())
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    await act(async () => { hook.result.current.recoveryValue?.refresh() })
    expect(handlers.onExtras).not.toHaveBeenCalled()
  })

  it("clearExtras removes the entry from memory and storage", async () => {
    actions.submitMyLeadCommand.mockRejectedValue(new Error("network"))
    const { hook } = setup(opening())
    await act(async () => { await hook.result.current.submit({ outcome: "reached", postCall: extras() }).catch(() => undefined) })
    const key = (actions.submitMyLeadCommand.mock.calls[0][1] as { idempotencyKey: string }).idempotencyKey
    clearExtras("user-1", key)
    simulateExtrasReloadForTests()
    expect(getExtras("user-1", key)).toBeNull()
    expect(window.sessionStorage.getItem(EXTRAS_STORAGE_KEY)).toBeNull()
  })

  it("works when sessionStorage throws (memory still holds the entry)", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked") })
    try {
      actions.submitMyLeadCommand.mockResolvedValue({ ok: false, answered: true, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "dup" })
      const { hook, handlers } = setup(opening())
      await act(async () => { await hook.result.current.submit({ outcome: "reached", postCall: extras() }) })
      expect(handlers.onExtras).toHaveBeenCalledTimes(1)
    } finally { setItem.mockRestore() }
  })
})
