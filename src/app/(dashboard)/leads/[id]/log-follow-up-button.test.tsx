import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  loadMyLeadRow: vi.fn(),
  loadMyLeadCallReferences: vi.fn(),
  submitMyLeadCommand: vi.fn(),
  submitMyLeadHandoffDrip: vi.fn(),
  results: [] as unknown[],
}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock("@/app/(dashboard)/my-leads/actions", () => ({
  loadMyLeadRow: mocks.loadMyLeadRow, loadMyLeadCallReferences: mocks.loadMyLeadCallReferences,
  submitMyLeadCommand: mocks.submitMyLeadCommand, submitMyLeadHandoffDrip: mocks.submitMyLeadHandoffDrip,
}))
vi.mock("@/app/(dashboard)/my-leads/_components/attempt-dialog", () => ({
  AcquisitionAttemptDialog: (props: { propertyId: string; onSubmit: (payload: object) => Promise<unknown>; onDripChanged?: () => void; callReferenceOptions?: unknown[] }) => (
    <div role="dialog" aria-label="Log an attempt">
      <button onClick={() => { void props.onSubmit({ outcome: "reached", note: "first" }).then((r) => mocks.results.push(r), (e) => mocks.results.push(e)) }}>Save first</button>
      <button onClick={() => { void props.onSubmit({ outcome: "reached", note: "edited" }).then((r) => mocks.results.push(r), (e) => mocks.results.push(e)) }}>Save edited</button>
      <button onClick={() => props.onDripChanged?.()}>Drip changed</button>
    </div>
  ),
}))

import { LogFollowUpButton } from "./log-follow-up-button"

const row = { propertyId: "lead-1", assignmentEpisodeId: "ep-1", queueVersion: 3, sharedStatus: "interested", address: "1 Main" }
const foundRow = { ok: true, lookup: { status: "found", row, snapshotAt: "x" } }
const props = { propertyId: "lead-1", propertyLabel: "1 Main", assigneeId: "rep-9", disabledReason: null }
const sent = (i: number) => mocks.submitMyLeadCommand.mock.calls[i][1] as Record<string, unknown>

describe("LogFollowUpButton", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) if (typeof m === "function") m.mockReset()
    mocks.results.length = 0
    mocks.loadMyLeadRow.mockResolvedValue(foundRow)
    mocks.loadMyLeadCallReferences.mockResolvedValue({ ok: true, options: [] })
  })

  it("is disabled with the reason when the viewer cannot log for this lead", async () => {
    render(<LogFollowUpButton {...props} disabledReason="This lead is assigned to another rep." />)
    const button = screen.getByRole("button", { name: "Log follow-up" })
    expect(button).toBeDisabled()
    expect(screen.getByTestId("log-follow-up-note")).toHaveTextContent("assigned to another rep")
    await userEvent.setup().click(button)
    expect(mocks.loadMyLeadRow).not.toHaveBeenCalled()
  })

  it("opens the attempt dialog in place from the assignee's row and loads the assignee's call references", async () => {
    const user = userEvent.setup()
    render(<LogFollowUpButton {...props} />)
    await user.click(screen.getByRole("button", { name: "Log follow-up" }))
    await screen.findByRole("dialog")
    expect(mocks.loadMyLeadRow).toHaveBeenCalledWith({ memberId: "rep-9", propertyId: "lead-1" })
    await waitFor(() => expect(mocks.loadMyLeadCallReferences).toHaveBeenCalledWith("lead-1", "rep-9"))
  })

  it("explains an unavailable lead instead of opening the dialog", async () => {
    mocks.loadMyLeadRow.mockResolvedValue({ ok: true, lookup: { status: "unavailable", reason: "archived" } })
    render(<LogFollowUpButton {...props} />)
    await userEvent.setup().click(screen.getByRole("button", { name: "Log follow-up" }))
    expect(await screen.findByTestId("log-follow-up-note")).toHaveTextContent("This lead was archived from My Leads.")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("saves with the lookup's version, refreshes the page, and keeps the dialog open for the drip step", async () => {
    const user = userEvent.setup()
    mocks.submitMyLeadCommand.mockResolvedValue({ ok: true, attemptRecorded: true })
    render(<LogFollowUpButton {...props} />)
    await user.click(screen.getByRole("button", { name: "Log follow-up" }))
    await user.click(await screen.findByRole("button", { name: "Save first" }))
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
    expect(mocks.submitMyLeadCommand).toHaveBeenCalledWith("log-attempt", expect.objectContaining({ propertyId: "lead-1", expectedEpisodeId: "ep-1", expectedQueueVersion: 3, expectedSharedStatus: "interested" }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    mocks.refresh.mockClear()
    await user.click(screen.getByRole("button", { name: "Drip changed" }))
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it("replays the frozen original payload after an uncertain save, even if the draft was edited", async () => {
    const user = userEvent.setup()
    mocks.submitMyLeadCommand.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ ok: true, attemptRecorded: true })
    render(<LogFollowUpButton {...props} />)
    await user.click(screen.getByRole("button", { name: "Log follow-up" }))
    await user.click(await screen.findByRole("button", { name: "Save first" }))
    await waitFor(() => expect(mocks.results).toHaveLength(1))
    await user.click(screen.getByRole("button", { name: "Save edited" }))
    await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2))
    expect(sent(1)).toEqual(sent(0))
    expect(sent(1).note).toBe("first")
  })

  it("takes the not-confirmed branch and replays the same request", async () => {
    const user = userEvent.setup()
    mocks.submitMyLeadCommand
      .mockResolvedValueOnce({ ok: false, message: "The update was not confirmed. Retry with the same form." })
      .mockResolvedValueOnce({ ok: true, attemptRecorded: true })
    render(<LogFollowUpButton {...props} />)
    await user.click(screen.getByRole("button", { name: "Log follow-up" }))
    await user.click(await screen.findByRole("button", { name: "Save first" }))
    await waitFor(() => expect(mocks.results).toHaveLength(1))
    await user.click(screen.getByRole("button", { name: "Save edited" }))
    await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2))
    expect(sent(1).idempotencyKey).toBe(sent(0).idempotencyKey)
    expect(sent(1).note).toBe("first")
    await act(async () => {})
  })
})
