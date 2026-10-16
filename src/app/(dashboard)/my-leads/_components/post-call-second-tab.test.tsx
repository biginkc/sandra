vi.mock("@/lib/sequences/drip-progress", () => ({ listDripProgress: vi.fn(async () => []) }))
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }))
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const actions = vi.hoisted(() => ({ submitMyLeadCommand: vi.fn(), submitMyLeadHandoffDrip: vi.fn(), savePostCallExtras: vi.fn() }))
vi.mock("../actions", () => actions)
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ listDripChoices: vi.fn(async () => ({ ok: true, data: [] })), startDripForLeads: vi.fn() }))

import type { QueueRow } from "@/lib/my-leads/queries"
import { listExtrasFor, resetExtrasStoreForTests, simulateExtrasReloadForTests } from "./extras-store"
import { PostCallPrompt } from "./post-call-prompt"
import { resetSubmissionStoreForTests } from "./submission-store"
import { useAttemptWorkflow, type AttemptOpening } from "./use-attempt-workflow"
import { saveExtrasRequest } from "./extras-saver"
import { WorkflowRecoveryContext } from "./workflow-form"

const VIEWER = { userId: "user-1", orgId: "org-1" }
const row = { propertyId: "p1", assignmentEpisodeId: "ep-1", queueVersion: 3, sharedStatus: "new_lead", address: "1 Main" } as unknown as QueueRow
const opening: AttemptOpening = { action: "log-attempt", row }

// The same wiring the call screen and My Leads use: the workflow hook, its recovery context, the
// prompt, and the extras saver that runs only after a committed save or a recovery that proves it.
function Harness() {
  const inFlight = new Set<string>()
  const { submit, recoveryValue } = useAttemptWorkflow<AttemptOpening>({
    opening,
    memberId: "rep-1",
    viewer: VIEWER,
    readRow: async () => row,
    onCommitted: async (committed) => {
      if (committed.extras) await saveExtrasRequest({ attemptKey: committed.attemptKey, memberId: "rep-1", propertyId: "p1", extras: committed.extras }, VIEWER.userId, inFlight)
    },
    onExtras: (flush) => { void saveExtrasRequest({ attemptKey: flush.attemptKey, memberId: flush.memberId, propertyId: flush.propertyId, extras: flush.extras }, VIEWER.userId, inFlight) },
    onSettled: () => undefined,
    onClose: () => undefined,
    onDripChanged: () => undefined,
  })
  return (
    <WorkflowRecoveryContext.Provider value={recoveryValue}>
      <PostCallPrompt variant="dock" open propertyId="p1" propertyLabel="1 Main" onOpenChange={() => undefined}
        onSubmit={(payload) => submit(payload)} viewerUserId="user-1" viewerLabel="Maria"
        initialCallActivityId="call-1" callReferenceOptions={[{ id: "call-1", label: "9 AM Central", provider: "sandra_softphone", callOutcome: null, talkSeconds: null }]} />
    </WorkflowRecoveryContext.Provider>
  )
}

describe("second prompt for an already-saved call", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    resetExtrasStoreForTests()
    resetSubmissionStoreForTests()
    actions.submitMyLeadCommand.mockReset()
    actions.savePostCallExtras.mockReset()
  })

  it("shows the existing already-saved wording, blocks Save, and writes no note or next step", async () => {
    // What the server answers when tab A already finalized this call under its own key.
    actions.submitMyLeadCommand.mockResolvedValue({ ok: false, answered: true, certainty: "rejected", code: "ALREADY_FINALIZED", message: "This was already saved. Refresh to see it." })
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(within(screen.getByTestId("post-call-outcome")).getByRole("radio", { name: "Reached" }))
    await user.type(screen.getByTestId("post-call-note"), "Seller wants a call Friday")
    await user.click(screen.getByTestId("post-call-pick-tomorrow"))
    await user.click(screen.getByRole("button", { name: "Save" }))

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("This was already saved. Refresh to see it.")
    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(screen.queryByTestId("post-call-receipt")).toBeNull()
    expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
    // The refused second save never reaches the note or the appointment.
    await waitFor(() => expect(actions.savePostCallExtras).not.toHaveBeenCalled())
    // The refused save's stored note and next step are gone, so after a reload the call screen's
    // not-saved banner (listExtrasFor) has nothing to show and no Retry to offer.
    expect(listExtrasFor("user-1", "p1")).toEqual([])
    simulateExtrasReloadForTests()
    expect(listExtrasFor("user-1", "p1")).toEqual([])
    expect(window.sessionStorage.getItem("sandra:my-leads:post-call-extras:v1")).toBeNull()
  })

  it("the extras saver KEEPS the stored entry when the server has no proof yet (pending), for Retry (matrix 7, 8)", async () => {
    const { putExtras, getExtras } = await import("./extras-store")
    const extras = { submissionId: "11111111-1111-4111-8111-111111111111", note: "n", nextStep: null, callActivityId: null }
    putExtras({ viewerUserId: "user-1", attemptKey: "k2", propertyId: "p1", memberId: "rep-1", extras })
    actions.savePostCallExtras.mockResolvedValue({ ok: false, pending: true, message: "Not saved yet: this call's save isn't confirmed. Your note is kept." })
    const result = await saveExtrasRequest({ attemptKey: "k2", memberId: "rep-1", propertyId: "p1", extras }, "user-1", new Set())
    expect(result).toMatchObject({ ok: false, pending: true })
    expect(getExtras("user-1", "k2")).not.toBeNull()
  })

  it("repeated and racing saves of one request write once per request (matrix 11)", async () => {
    const extras = { submissionId: "11111111-1111-4111-8111-111111111111", note: "n", nextStep: null, callActivityId: null }
    let release: () => void = () => undefined
    actions.savePostCallExtras.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ ok: true, note: "saved", nextStep: "skipped" }) }))
    const inFlight = new Set<string>()
    const first = saveExtrasRequest({ attemptKey: "k3", memberId: "rep-1", propertyId: "p1", extras }, "user-1", inFlight)
    const second = await saveExtrasRequest({ attemptKey: "k3", memberId: "rep-1", propertyId: "p1", extras }, "user-1", inFlight)
    expect(second).toBeNull()
    release()
    await first
    expect(actions.savePostCallExtras).toHaveBeenCalledTimes(1)
  })

  it("the extras saver drops the stored entry when the server says another prompt already saved the call", async () => {
    const { putExtras, getExtras } = await import("./extras-store")
    const extras = { submissionId: "11111111-1111-4111-8111-111111111111", note: "n", nextStep: null, callActivityId: "22222222-2222-4222-8222-222222222222" }
    putExtras({ viewerUserId: "user-1", attemptKey: "k1", propertyId: "p1", memberId: "rep-1", extras })
    actions.savePostCallExtras.mockResolvedValue({ ok: false, message: "This was already saved. Refresh to see it.", alreadySaved: true })
    await saveExtrasRequest({ attemptKey: "k1", memberId: "rep-1", propertyId: "p1", extras }, "user-1", new Set())
    expect(actions.savePostCallExtras).toHaveBeenCalledWith(expect.objectContaining({ attemptKey: "k1", callActivityId: extras.callActivityId }))
    expect(getExtras("user-1", "k1")).toBeNull()
  })
})
