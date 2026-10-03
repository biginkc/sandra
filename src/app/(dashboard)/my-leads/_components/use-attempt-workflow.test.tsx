import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const actions = vi.hoisted(() => ({ submitMyLeadCommand: vi.fn(), submitMyLeadHandoffDrip: vi.fn() }))
vi.mock("../actions", () => ({ submitMyLeadCommand: actions.submitMyLeadCommand, submitMyLeadHandoffDrip: actions.submitMyLeadHandoffDrip }))

import type { QueueRow } from "@/lib/my-leads/queries"
import { useAttemptWorkflow, type AttemptOpening } from "./use-attempt-workflow"

const row = (overrides: Partial<QueueRow> = {}) =>
  ({ propertyId: "p1", assignmentEpisodeId: "ep-1", queueVersion: 3, sharedStatus: "new_lead", address: "1 Main", ...overrides }) as unknown as QueueRow
const opening = (action: AttemptOpening["action"] = "log-attempt", r = row()): AttemptOpening => ({ action, row: r })

function setup(initial: AttemptOpening | null, readRow = vi.fn(async (): Promise<QueueRow | null> => row())) {
  const handlers = {
    readRow,
    onCommitted: vi.fn(async () => undefined),
    onSettled: vi.fn(),
    onClose: vi.fn(),
    onDripChanged: vi.fn(),
  }
  const hook = renderHook(({ current }: { current: AttemptOpening | null }) =>
    useAttemptWorkflow({ opening: current, memberId: "rep-1", ...handlers }), { initialProps: { current: initial } })
  return { hook, handlers }
}

const sentInput = (call = 0) => actions.submitMyLeadCommand.mock.calls[call][1] as Record<string, unknown>

describe("useAttemptWorkflow", () => {
  beforeEach(() => {
    actions.submitMyLeadCommand.mockReset()
    actions.submitMyLeadHandoffDrip.mockReset()
  })

  it("uses one idempotency key per opening and a new one for the next opening", async () => {
    actions.submitMyLeadCommand.mockResolvedValue({ ok: false, message: "Pick an outcome." })
    const first = opening()
    const { hook } = setup(first)
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }) })
    expect(sentInput(0).idempotencyKey).toBe(sentInput(1).idempotencyKey)
    // Before the save is uncertain, a deterministic rejection may be retried with the edited draft.
    expect(sentInput(1).note).toBe("edited")

    hook.rerender({ current: opening() })
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    expect(sentInput(2).idempotencyKey).not.toBe(sentInput(0).idempotencyKey)
  })

  it("freezes the payload once a save is uncertain and replays it immutably", async () => {
    actions.submitMyLeadCommand
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: false, message: "The update was not confirmed. Retry with the same form." })
      .mockResolvedValueOnce({ ok: true, attemptRecorded: true })
    const { hook, handlers } = setup(opening())
    await act(async () => { await expect(hook.result.current.submit({ outcome: "reached", note: "original" })).rejects.toThrow("network") })
    expect(hook.result.current.recoveryValue?.reconciliation).toMatchObject({ command: "log-attempt", payload: { note: "original" } })
    await act(async () => { await hook.result.current.submit({ outcome: "no_answer", note: "edited while unconfirmed" }) })
    await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited again" }) })
    const [a, b, c] = [sentInput(0), sentInput(1), sentInput(2)]
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    expect(c.note).toBe("original")
    expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
  })

  it("keeps the receipt for the not-confirmed branch without throwing", async () => {
    actions.submitMyLeadCommand.mockResolvedValue({ ok: false, message: "The update was not confirmed. Retry with the same form." })
    const { hook } = setup(opening())
    await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "n" }) })
    expect(hook.result.current.recoveryValue).toMatchObject({ blocked: false, busy: false, reconciliation: { payload: { note: "n" } } })
    expect(hook.result.current.recoveryValue?.message).toMatch(/could not confirm/)
  })

  it("stays open for the drip step after any successful attempt, including a non-no-answer outcome", async () => {
    actions.submitMyLeadCommand.mockResolvedValue({ ok: true, attemptRecorded: true })
    const { hook, handlers } = setup(opening("log-attempt"))
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    expect(handlers.onClose).not.toHaveBeenCalled()
    expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(handlers.onSettled).toHaveBeenCalledTimes(1))
    // Attempt dialog keeps its key so the optional drip step cannot create a second attempt.
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    expect(sentInput(0).idempotencyKey).toBe(sentInput(1).idempotencyKey)
    act(() => hook.result.current.onDripChanged())
    expect(handlers.onDripChanged).toHaveBeenCalledTimes(1)
  })

  it("closes other actions after the confirmed save and clears their key", async () => {
    actions.submitMyLeadCommand.mockResolvedValue({ ok: true })
    const o = opening("log-offer")
    const { hook, handlers } = setup(o)
    await act(async () => { await hook.result.current.submit({ amount: 1 }) })
    expect(handlers.onClose).toHaveBeenCalledWith(o)
    expect(handlers.onSettled).toHaveBeenCalledTimes(1)
  })

  it("ignores a recovery read that finishes after the opening changed", async () => {
    let resolve!: (value: QueueRow | null) => void
    const readRow = vi.fn(() => new Promise<QueueRow | null>((r) => { resolve = r }))
    const first = opening()
    const { hook } = setup(first, readRow)
    actions.submitMyLeadCommand.mockResolvedValue({ ok: false, message: "stale", code: "STALE_STATE" })
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    expect(hook.result.current.recoveryValue?.blocked).toBe(true)
    act(() => hook.result.current.recoveryValue?.refresh())
    hook.rerender({ current: opening() })
    await act(async () => { resolve(row()) })
    expect(hook.result.current.recoveryValue).toBeNull()
  })

  it("refreshes through the injected reader, keeps the key, and submits with the refreshed row", async () => {
    actions.submitMyLeadCommand
      .mockResolvedValueOnce({ ok: false, message: "stale", code: "STALE_STATE" })
      .mockResolvedValueOnce({ ok: true })
    const readRow = vi.fn(async () => row({ queueVersion: 9 }))
    const { hook } = setup(opening("log-attempt"), readRow)
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    expect(hook.result.current.recoveryValue?.blocked).toBe(true)
    await act(async () => { hook.result.current.recoveryValue?.refresh() })
    expect(readRow).toHaveBeenCalledTimes(1)
    expect(hook.result.current.recoveryValue?.blocked).toBe(false)
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    expect(sentInput(1).expectedQueueVersion).toBe(9)
    expect(sentInput(1).idempotencyKey).toBe(sentInput(0).idempotencyKey)
  })

  it("blocks recovery when the lead moved to a different assignment episode", async () => {
    actions.submitMyLeadCommand.mockResolvedValue({ ok: false, message: "stale", code: "STALE_STATE" })
    const readRow = vi.fn(async () => row({ assignmentEpisodeId: "ep-2" }))
    const { hook } = setup(opening(), readRow)
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    await act(async () => { hook.result.current.recoveryValue?.refresh() })
    expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, busy: false })
    expect(hook.result.current.recoveryValue?.message).toMatch(/assignment changed/)
  })
})
