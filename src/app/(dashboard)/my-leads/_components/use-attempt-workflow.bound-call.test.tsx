import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const actions = vi.hoisted(() => ({ submitMyLeadCommand: vi.fn(), submitMyLeadHandoffDrip: vi.fn() }))
vi.mock("../actions", () => actions)

import type { QueueRow } from "@/lib/my-leads/queries"
import { listExtrasFor, resetExtrasStoreForTests } from "./extras-store"
import { listSubmissions, resetSubmissionStoreForTests } from "./submission-store"
import { boundCallFinalized, useAttemptWorkflow, type AttemptCommitted, type AttemptOpening } from "./use-attempt-workflow"

const VIEWER = { userId: "user-1", orgId: "org-1" }
const row = { propertyId: "p1", assignmentEpisodeId: "ep-1", queueVersion: 3, sharedStatus: "new_lead", address: "1 Main" } as unknown as QueueRow
const scope = { viewerUserId: "user-1", orgId: "org-1", memberId: "rep-1", propertyId: "p1", assignmentEpisodeId: "ep-1" }

function mount(opening: AttemptOpening, onCommitted: (c: AttemptCommitted<AttemptOpening>) => void) {
  return renderHook(() =>
    useAttemptWorkflow<AttemptOpening>({
      opening, memberId: "rep-1", viewer: VIEWER, readRow: async () => row,
      onCommitted: async (c) => { onCommitted(c) },
      onSettled: () => undefined, onClose: () => undefined, onDripChanged: () => undefined,
    }),
  )
}

describe("a bound Sandra call prompt and an unresolved manual save (real workflow)", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    resetExtrasStoreForTests()
    resetSubmissionStoreForTests()
    actions.submitMyLeadCommand.mockReset()
  })

  it("does not adopt the manual record, keeps it protected, and marks call B logged only when B's own finalize commits", async () => {
    // 1. A manual save whose response is lost: the record is unresolved.
    actions.submitMyLeadCommand.mockRejectedValueOnce(new Error("network"))
    const manualCommitted = vi.fn()
    const manual = mount({ action: "log-attempt", row }, manualCommitted)
    await act(async () => { await manual.result.current.submit({ source: "manual", outcome: "reached" }).catch(() => undefined) })
    expect(manualCommitted).not.toHaveBeenCalled()
    expect(listSubmissions(scope, () => true).some((r) => r.status === "uncertain" && r.route === "log_attempt")).toBe(true)
    manual.unmount()

    // 2. Without a reload, the rep finishes Sandra call B and opens its bound prompt.
    const boundCommitted = vi.fn()
    const bound = mount({ action: "log-attempt", row, callActivityId: "call-B" }, boundCommitted)
    // The manual record is NOT adopted: no recovery state, no manual payload replayed through this prompt.
    expect(bound.result.current.recoveryValue).toBeNull()

    actions.submitMyLeadCommand.mockResolvedValueOnce({ ok: true })
    await act(async () => { await bound.result.current.submit({ source: "sandra", callActivityId: "call-B", outcome: "reached" }) })
    await waitFor(() => expect(boundCommitted).toHaveBeenCalledTimes(1))
    const sent = actions.submitMyLeadCommand.mock.calls.at(-1)![1] as Record<string, unknown>
    expect(sent).toMatchObject({ source: "sandra", callActivityId: "call-B" })
    expect(boundCallFinalized(boundCommitted.mock.calls[0][0])).toBe("call-B")

    // 3. The earlier manual record is still there, untouched.
    expect(listSubmissions(scope, () => true).some((r) => r.status === "uncertain" && r.route === "log_attempt")).toBe(true)
    expect(listExtrasFor("user-1", "p1")).toBeDefined()
  })

  it("a committed save that is not this call's own sandra finalize never counts as the bound call", () => {
    const opening: AttemptOpening = { action: "log-attempt", row, callActivityId: "call-B" }
    const make = (input: Record<string, unknown>) => ({ opening, input, attemptKey: "k" }) as unknown as AttemptCommitted<AttemptOpening>
    expect(boundCallFinalized(make({ source: "manual", callActivityId: "call-B" }))).toBeNull()
    expect(boundCallFinalized(make({ source: "sandra", callActivityId: "call-A" }))).toBeNull()
    expect(boundCallFinalized(make({ source: "sandra", callActivityId: "call-B" }))).toBe("call-B")
  })
})
