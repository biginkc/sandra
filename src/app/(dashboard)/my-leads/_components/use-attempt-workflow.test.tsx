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
    actions.submitMyLeadCommand.mockResolvedValue({ ok: false, certainty: "rejected", message: "Pick an outcome." })
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
    actions.submitMyLeadCommand.mockResolvedValue({ ok: false, certainty: "rejected", message: "stale", code: "STALE_STATE" })
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    expect(hook.result.current.recoveryValue?.blocked).toBe(true)
    act(() => hook.result.current.recoveryValue?.refresh())
    hook.rerender({ current: opening() })
    await act(async () => { resolve(row()) })
    expect(hook.result.current.recoveryValue).toBeNull()
  })

  it("refreshes through the injected reader, keeps the key, and submits with the refreshed row", async () => {
    actions.submitMyLeadCommand
      .mockResolvedValueOnce({ ok: false, certainty: "rejected", message: "stale", code: "STALE_STATE" })
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
    actions.submitMyLeadCommand.mockResolvedValue({ ok: false, certainty: "rejected", message: "stale", code: "STALE_STATE" })
    const readRow = vi.fn(async () => row({ assignmentEpisodeId: "ep-2" }))
    const { hook } = setup(opening(), readRow)
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    await act(async () => { hook.result.current.recoveryValue?.refresh() })
    expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, busy: false })
    expect(hook.result.current.recoveryValue?.message).toMatch(/assignment changed/)
  })

  it("a save that never answers ends in the uncertain state and replays the frozen request", async () => {
    vi.useFakeTimers()
    try {
      actions.submitMyLeadCommand.mockImplementationOnce(() => new Promise(() => undefined)).mockResolvedValueOnce({ ok: true, attemptRecorded: true })
      const { hook } = setup(opening())
      let outcome: unknown
      await act(async () => { void hook.result.current.submit({ outcome: "reached", note: "original" }).then(() => undefined, (e) => { outcome = e }) })
      expect(outcome).toBeUndefined()
      await act(async () => { await vi.advanceTimersByTimeAsync(25_001) })
      expect(outcome).toBeInstanceOf(Error)
      expect(hook.result.current.recoveryValue?.reconciliation).toMatchObject({ payload: { note: "original" } })
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }) })
      expect(sentInput(1)).toEqual(sentInput(0))
    } finally { vi.useRealTimers() }
  })

  it("a definite STALE_STATE answer makes exactly one server call and the client never resubmits on its own", async () => {
    actions.submitMyLeadCommand.mockResolvedValue({ ok: false, certainty: "rejected", code: "STALE_STATE", message: "This lead changed." })
    const { hook } = setup(opening())
    await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
    expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, busy: false })
  })

  describe.each([
    ["a timed-out save", () => new Promise(() => undefined), true],
    ["a network error", () => Promise.reject(new Error("network")), false],
  ])("uncertain replay (%s) then a definite stale answer", (_name, firstAttempt, useTimers) => {
    it("leaves replay mode: refresh builds a NEW payload with the refreshed version and the same key", async () => {
      if (useTimers) vi.useFakeTimers()
      try {
        actions.submitMyLeadCommand
          .mockImplementationOnce(firstAttempt as () => Promise<unknown>)
          .mockResolvedValueOnce({ ok: false, certainty: "rejected", code: "STALE_STATE", message: "This lead changed." })
          .mockResolvedValueOnce({ ok: true, attemptRecorded: true })
        const readRow = vi.fn(async (): Promise<QueueRow | null> => row({ queueVersion: 2 }))
        const { hook, handlers } = setup(opening("log-attempt", row({ queueVersion: 1 })), readRow)
        await act(async () => {
          const pending = hook.result.current.submit({ outcome: "reached", note: "original" }).then(() => undefined, () => undefined)
          if (useTimers) await vi.advanceTimersByTimeAsync(25_001)
          await pending
        })
        expect(hook.result.current.recoveryValue?.reconciliation).toBeTruthy()
        // Replay of the frozen request: the server says stale (so nothing ever committed).
        await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }) })
        expect(sentInput(1)).toEqual(sentInput(0))
        expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, reconciliation: undefined })
        await act(async () => { hook.result.current.recoveryValue?.refresh() })
        expect(hook.result.current.recoveryValue?.blocked).toBe(false)
        const result = await act(async () => hook.result.current.submit({ outcome: "reached", note: "edited" }))
        void result
        expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(3)
        expect(sentInput(2).expectedQueueVersion).toBe(2)
        expect(sentInput(2).note).toBe("edited")
        expect(sentInput(2).idempotencyKey).toBe(sentInput(0).idempotencyKey)
        expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
      } finally { if (useTimers) vi.useRealTimers() }
    })
  })

  describe("certainty of a failed answer", () => {
    it("commit then timeout: an unknown replay failure keeps reconciliation, and the next replay is a duplicate success", async () => {
      vi.useFakeTimers()
      try {
        actions.submitMyLeadCommand
          .mockImplementationOnce(() => new Promise(() => undefined))
          .mockResolvedValueOnce({ ok: false, certainty: "unknown", message: "The update could not be confirmed. Retry with the same form." })
          .mockResolvedValueOnce({ ok: true, duplicate: true, attemptRecorded: true })
        const { hook, handlers } = setup(opening("log-attempt", row({ queueVersion: 1 })))
        await act(async () => {
          const pending = hook.result.current.submit({ outcome: "reached", note: "original" }).then(() => undefined, () => undefined)
          await vi.advanceTimersByTimeAsync(25_001)
          await pending
        })
        await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }) })
        // The failure proved nothing: reconciliation stays and the payload stays frozen.
        expect(hook.result.current.recoveryValue?.reconciliation).toMatchObject({ payload: { note: "original" } })
        await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited again" }) })
        expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(3)
        expect(sentInput(2)).toEqual(sentInput(0))
        expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
      } finally { vi.useRealTimers() }
    })

    it("an unknown failure on a first attempt freezes the request for replay", async () => {
      actions.submitMyLeadCommand.mockResolvedValueOnce({ ok: false, certainty: "unknown", message: "The update could not be confirmed." }).mockResolvedValueOnce({ ok: true })
      const { hook } = setup(opening("log-attempt"))
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "first" }) })
      expect(hook.result.current.recoveryValue?.reconciliation).toBeTruthy()
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }) })
      expect(sentInput(1)).toEqual(sentInput(0))
    })

    const conflict = { ok: false, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "This was already saved. Refresh to see it." }

    it("IDEMPOTENCY_CONFLICT blocks; Refresh runs the committed path, shows Saved earlier, and the next Save only moves the dialog on", async () => {
      actions.submitMyLeadCommand.mockResolvedValue(conflict)
      const { hook, handlers } = setup(opening("log-attempt"))
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }) })
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, message: "This was already saved. Refresh to see it." })
      // Blocked: a further save never reaches the server.
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "again" }) })
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      // The host's barrier and refresh ran; an attempt keeps its dialog for the follow-up/drip step.
      expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(handlers.onSettled).toHaveBeenCalledTimes(1))
      expect(handlers.onClose).not.toHaveBeenCalled()
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: false, message: "Saved earlier. Your update is recorded." })
      let moved: unknown
      await act(async () => { moved = await hook.result.current.submit({ outcome: "reached" }) })
      expect(moved).toMatchObject({ ok: true, attemptRecorded: true })
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
    })

    it("IDEMPOTENCY_CONFLICT on an action that ends after one save: Refresh runs the committed path and closes", async () => {
      actions.submitMyLeadCommand.mockResolvedValue(conflict)
      const { hook, handlers } = setup(opening("log-offer"))
      await act(async () => { await hook.result.current.submit({ amountCents: 1 }) })
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
      expect(handlers.onClose).toHaveBeenCalledTimes(1)
      expect(handlers.onSettled).toHaveBeenCalledTimes(1)
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
    })

    it("a failed refresh after IDEMPOTENCY_CONFLICT stays blocked and retryable", async () => {
      actions.submitMyLeadCommand.mockResolvedValue(conflict)
      const readRow = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(row())
      const { hook, handlers } = setup(opening("log-attempt"), readRow)
      await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true })
      expect(handlers.onCommitted).not.toHaveBeenCalled()
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
    })

    it("receipt exists, then FORBIDDEN: reconciliation is kept (same key), and once access is back the replay is a duplicate success", async () => {
      actions.submitMyLeadCommand
        .mockResolvedValueOnce({ ok: false, certainty: "unknown", code: "FORBIDDEN", message: "This lead is unavailable or you no longer have access." })
        .mockResolvedValueOnce({ ok: true, duplicate: true, attemptRecorded: true })
      const readRow = vi.fn(async (): Promise<QueueRow | null> => row({ queueVersion: 1 }))
      const { hook, handlers } = setup(opening("log-attempt", row({ queueVersion: 1 })), readRow)
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "original" }) })
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, reconciliation: { payload: { note: "original" } } })
      // Blocked while access is gone.
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }) })
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
      // Refresh re-reads the row and does NOT release the frozen payload.
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      expect(readRow).toHaveBeenCalledTimes(1)
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: false, reconciliation: { payload: { note: "original" } } })
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }) })
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(2)
      expect(sentInput(1)).toEqual(sentInput(0))
      expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
    })

    it("Refresh in the reconciliation state only re-reads the row: the frozen payload and key survive it", async () => {
      actions.submitMyLeadCommand
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValueOnce({ ok: true, duplicate: true, attemptRecorded: true })
      const readRow = vi.fn(async (): Promise<QueueRow | null> => row({ queueVersion: 9 }))
      const { hook } = setup(opening("log-attempt", row({ queueVersion: 1 })), readRow)
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "original" }).catch(() => undefined) })
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: false, reconciliation: { payload: { note: "original" } } })
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      expect(readRow).toHaveBeenCalledTimes(1)
      expect(hook.result.current.recoveryValue).toMatchObject({ reconciliation: { payload: { note: "original" } } })
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }) })
      // The replay is the original request (queueVersion 1, not the refreshed 9).
      expect(sentInput(1)).toEqual(sentInput(0))
      expect(sentInput(1).expectedQueueVersion).toBe(1)
    })

    // Commit-then-timeout: the original committed but its answer never arrived.
    it.each([
      ["the replay throws", () => Promise.reject(new Error("fetch failed"))],
      ["the replay is an unknown failure", () => Promise.resolve({ ok: false, certainty: "unknown", message: "The update could not be confirmed. Retry with the same form." })],
      ["the replay is not confirmed", () => Promise.resolve({ ok: false, certainty: "unknown", message: "The update was not confirmed. Retry with the same form." })],
    ])("commit then timeout, then %s: frozen kept, same key, the next replay succeeds once", async (_name, replay) => {
      vi.useFakeTimers()
      try {
        actions.submitMyLeadCommand
          .mockImplementationOnce(() => new Promise(() => undefined))
          .mockImplementationOnce(replay as () => Promise<unknown>)
          .mockResolvedValueOnce({ ok: true, duplicate: true, attemptRecorded: true })
        const { hook, handlers } = setup(opening("log-attempt", row({ queueVersion: 1 })))
        await act(async () => {
          const pending = hook.result.current.submit({ outcome: "reached", note: "original" }).then(() => undefined, () => undefined)
          await vi.advanceTimersByTimeAsync(25_001)
          await pending
        })
        await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }).catch(() => undefined) })
        expect(hook.result.current.recoveryValue?.reconciliation).toMatchObject({ payload: { note: "original" } })
        await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited again" }) })
        expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(3)
        expect(sentInput(1)).toEqual(sentInput(0))
        expect(sentInput(2)).toEqual(sentInput(0))
        expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
      } finally { vi.useRealTimers() }
    })

    it("FORBIDDEN without a receipt: blocked, never released; the payload and key stay frozen", async () => {
      const forbidden = { ok: false, certainty: "unknown", code: "FORBIDDEN", message: "No access." }
      actions.submitMyLeadCommand.mockResolvedValue(forbidden)
      const { hook } = setup(opening("log-attempt", row({ queueVersion: 1 })))
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "original" }) })
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }) })
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(2)
      expect(sentInput(1)).toEqual(sentInput(0))
      expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, reconciliation: { payload: { note: "original" } } })
    })

    it("a late ok after the timeout is a committed save, with no click", async () => {
      vi.useFakeTimers()
      try {
        let answer!: (value: unknown) => void
        actions.submitMyLeadCommand.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
        const { hook, handlers } = setup(opening("log-attempt"))
        await act(async () => {
          const pending = hook.result.current.submit({ outcome: "reached" }).then(() => undefined, () => undefined)
          await vi.advanceTimersByTimeAsync(25_001)
          await pending
        })
        expect(handlers.onCommitted).not.toHaveBeenCalled()
        await act(async () => { answer({ ok: true, attemptRecorded: true }) })
        expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
        expect(hook.result.current.recoveryValue).toBeNull()
        expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
      } finally { vi.useRealTimers() }
    })

    it("a late result is ignored while a replay is in flight", async () => {
      vi.useFakeTimers()
      try {
        let answer!: (value: unknown) => void
        let replay!: (value: unknown) => void
        actions.submitMyLeadCommand
          .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
          .mockImplementationOnce(() => new Promise((resolve) => { replay = resolve }))
        const { hook, handlers } = setup(opening("log-attempt"))
        await act(async () => {
          const pending = hook.result.current.submit({ outcome: "reached" }).then(() => undefined, () => undefined)
          await vi.advanceTimersByTimeAsync(25_001)
          await pending
        })
        let replayDone: Promise<unknown> | undefined
        await act(async () => { replayDone = hook.result.current.submit({ outcome: "reached" }) })
        await act(async () => { answer({ ok: true, attemptRecorded: true }) })
        expect(handlers.onCommitted).not.toHaveBeenCalled()
        await act(async () => { replay({ ok: true, duplicate: true, attemptRecorded: true }); await replayDone })
        expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
      } finally { vi.useRealTimers() }
    })

    it("a late original after a sound STALE, then an edited save: already saved, one attempt", async () => {
      vi.useFakeTimers()
      try {
        let answer!: (value: unknown) => void
        actions.submitMyLeadCommand
          .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
          .mockResolvedValueOnce({ ok: false, certainty: "rejected", code: "STALE_STATE", message: "stale" })
          .mockResolvedValueOnce({ ok: false, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "This was already saved. Refresh to see it." })
        const { hook, handlers } = setup(opening("log-attempt", row({ queueVersion: 1 })))
        await act(async () => {
          const pending = hook.result.current.submit({ outcome: "reached", note: "original" }).then(() => undefined, () => undefined)
          await vi.advanceTimersByTimeAsync(25_001)
          await pending
        })
        await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "original" }) }) // replay: STALE, released
        await act(async () => { hook.result.current.recoveryValue?.refresh() })
        await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }) }) // original committed meanwhile: conflict
        expect(hook.result.current.recoveryValue).toMatchObject({ blocked: true, message: "This was already saved. Refresh to see it." })
        expect(sentInput(2).idempotencyKey).toBe(sentInput(0).idempotencyKey)
        expect(handlers.onCommitted).not.toHaveBeenCalled()
        await act(async () => { answer({ ok: true, attemptRecorded: true }) }) // the original's answer finally arrives
        expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
        expect(hook.result.current.recoveryValue).toBeNull()
      } finally { vi.useRealTimers() }
    })

    it("route switch after a release is blocked and sends nothing", async () => {
      actions.submitMyLeadCommand
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValueOnce({ ok: false, certainty: "rejected", code: "STALE_STATE", message: "stale" })
      const { hook } = setup(opening("log-attempt", row({ queueVersion: 1 })))
      await act(async () => { await hook.result.current.submit({ outcome: "reached", source: "dialpad" }).catch(() => undefined) })
      await act(async () => { await hook.result.current.submit({ outcome: "reached", source: "dialpad" }) }) // replay: STALE, released
      await act(async () => { hook.result.current.recoveryValue?.refresh() })
      let blocked: unknown
      await act(async () => { blocked = await hook.result.current.submit({ outcome: "reached", source: "sandra", callActivityId: "call-1" }) })
      expect(blocked).toMatchObject({ ok: false, certainty: "rejected" })
      expect((blocked as { message: string }).message).toMatch(/Cancel and start over/)
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(2)
    })

    it("a handoff that commits and then fails to start the drip is committed with a follow-up error and never resubmitted", async () => {
      actions.submitMyLeadHandoffDrip.mockResolvedValue({ ok: true, dripFailure: "Could not start the drip." })
      const { hook, handlers } = setup(opening("handoff", row({ queueVersion: 1 })))
      await act(async () => { await hook.result.current.submit({ sequenceId: "seq-1", reason: "not_interested" }) })
      expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(handlers.onSettled).toHaveBeenCalledTimes(1))
      expect(handlers.onSettled.mock.calls[0][0]).toMatchObject({ dripFailure: "Outcome saved. Drip not started: Could not start the drip." })
      expect(actions.submitMyLeadHandoffDrip).toHaveBeenCalledTimes(1)
    })

    it("UNAUTHENTICATED keeps the request frozen and shows the sign-in guidance", async () => {
      actions.submitMyLeadCommand.mockResolvedValueOnce({ ok: false, certainty: "unknown", code: "UNAUTHENTICATED", message: "Your session expired. Sign in again, then Reconcile." })
        .mockResolvedValueOnce({ ok: true, duplicate: true, attemptRecorded: true })
      const { hook } = setup(opening("log-attempt"))
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "original" }) })
      expect(hook.result.current.recoveryValue).toMatchObject({ message: "Your session expired. Sign in again, then Reconcile.", reconciliation: { payload: { note: "original" } } })
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }) })
      expect(sentInput(1)).toEqual(sentInput(0))
    })

    it("a replay of a frozen handoff is the identical request (member, sequence, key); a changed member prop is not exercised here", async () => {
      actions.submitMyLeadHandoffDrip
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValueOnce({ ok: true })
      const { hook } = setup(opening("handoff", row({ queueVersion: 1 })))
      await act(async () => { await hook.result.current.submit({ sequenceId: "seq-1" }).catch(() => undefined) })
      await act(async () => { await hook.result.current.submit({ sequenceId: "seq-1" }) })
      expect(actions.submitMyLeadHandoffDrip.mock.calls[1][0]).toEqual(actions.submitMyLeadHandoffDrip.mock.calls[0][0])
    })

    const invalid = { ok: false, answered: true, certainty: "unknown", message: "The update could not be saved. Check the fields and retry." }

    it("a first save the server answers with a validation error is not frozen: the form stays editable and a corrected save succeeds", async () => {
      actions.submitMyLeadCommand.mockResolvedValueOnce(invalid).mockResolvedValueOnce({ ok: true, attemptRecorded: true })
      const { hook, handlers } = setup(opening("log-attempt", row({ queueVersion: 1 })))
      let first: unknown
      await act(async () => { first = await hook.result.current.submit({ outcome: "reached", occurredAt: "future" }) })
      expect(first).toMatchObject({ ok: false, message: invalid.message })
      expect(hook.result.current.recoveryValue?.reconciliation).toBeUndefined()
      await act(async () => { await hook.result.current.submit({ outcome: "reached", occurredAt: "corrected" }) })
      expect(sentInput(1).occurredAt).toBe("corrected")
      expect(sentInput(1).idempotencyKey).toBe(sentInput(0).idempotencyKey)
      expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
    })

    it("the same validation error during a frozen replay stays frozen (strict allow-list)", async () => {
      actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(invalid)
      const { hook } = setup(opening("log-attempt", row({ queueVersion: 1 })))
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "original" }).catch(() => undefined) })
      await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "edited" }) })
      expect(hook.result.current.recoveryValue?.reconciliation).toMatchObject({ payload: { note: "original" } })
    })

    it("a late STALE after a replay committed changes nothing: no release, no block", async () => {
      vi.useFakeTimers()
      try {
        let lateAnswer!: (value: unknown) => void
        actions.submitMyLeadCommand
          .mockImplementationOnce(() => new Promise((resolve) => { lateAnswer = resolve }))
          .mockResolvedValueOnce({ ok: true, duplicate: true, attemptRecorded: true })
        const { hook, handlers } = setup(opening("log-attempt", row({ queueVersion: 1 })))
        await act(async () => {
          const pending = hook.result.current.submit({ outcome: "reached", note: "original" }).then(() => undefined, () => undefined)
          await vi.advanceTimersByTimeAsync(25_001)
          await pending
        })
        await act(async () => { await hook.result.current.submit({ outcome: "reached", note: "original" }) })
        expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
        await act(async () => { lateAnswer({ ok: false, certainty: "rejected", code: "STALE_STATE", message: "stale" }) })
        expect(hook.result.current.recoveryValue).toBeNull()
        expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
      } finally { vi.useRealTimers() }
    })

    it("a late ok after a replay committed does not run the committed path twice", async () => {
      vi.useFakeTimers()
      try {
        let lateAnswer!: (value: unknown) => void
        actions.submitMyLeadCommand
          .mockImplementationOnce(() => new Promise((resolve) => { lateAnswer = resolve }))
          .mockResolvedValueOnce({ ok: true, duplicate: true, attemptRecorded: true })
        const { hook, handlers } = setup(opening("log-attempt", row({ queueVersion: 1 })))
        await act(async () => {
          const pending = hook.result.current.submit({ outcome: "reached" }).then(() => undefined, () => undefined)
          await vi.advanceTimersByTimeAsync(25_001)
          await pending
        })
        await act(async () => { await hook.result.current.submit({ outcome: "reached" }) })
        await act(async () => { lateAnswer({ ok: true, attemptRecorded: true }) })
        expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
        await vi.waitFor(() => expect(handlers.onSettled).toHaveBeenCalledTimes(1))
      } finally { vi.useRealTimers() }
    })
  })
})

