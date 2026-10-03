import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  loadMyLeadRow: vi.fn(),
  loadMyLeadCallReferences: vi.fn(),
  submitMyLeadCommand: vi.fn(),
  submitMyLeadHandoffDrip: vi.fn(),
}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ listDripChoices: vi.fn(async () => ({ ok: true, data: [] })), startDripForLeads: vi.fn() }))
vi.mock("@/app/(dashboard)/my-leads/actions", () => ({
  loadMyLeadRow: mocks.loadMyLeadRow, loadMyLeadCallReferences: mocks.loadMyLeadCallReferences,
  submitMyLeadCommand: mocks.submitMyLeadCommand, submitMyLeadHandoffDrip: mocks.submitMyLeadHandoffDrip,
}))

import { LogFollowUpButton } from "./log-follow-up-button"

const row = (queueVersion: number) => ({ propertyId: "lead-1", assignmentEpisodeId: "ep-1", queueVersion, sharedStatus: "interested", address: "1 Main" })
const found = (queueVersion: number) => ({ ok: true, lookup: { status: "found", row: row(queueVersion), snapshotAt: "x" } })

async function fillAndSave(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(await screen.findByLabelText("External outcome"), "reached")
  fireEvent.change(screen.getByLabelText("When did the outreach occur?"), { target: { value: "2026-09-11T09:00" } })
  await user.click(screen.getByRole("button", { name: "Save attempt" }))
}

// The real attempt dialog, so a stuck "Saving…" would show up here.
describe("LogFollowUpButton two-tab sequence (real dialog)", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset()
    mocks.loadMyLeadCallReferences.mockResolvedValue({ ok: true, options: [] })
    mocks.loadMyLeadRow.mockResolvedValue(found(1))
  })

  it("a second save that the server rejects as stale ends in the recovery UI, not a stuck Saving…", async () => {
    const user = userEvent.setup()
    mocks.submitMyLeadCommand.mockResolvedValue({ ok: false, certainty: "rejected", code: "STALE_STATE", message: "This lead changed. Refresh before trying again." })
    render(<LogFollowUpButton propertyId="lead-1" propertyLabel="1 Main" assigneeId="rep-9" disabledReason={null} viewer={{ userId: "rep-9", orgId: "org-1" }} />)
    await user.click(screen.getByRole("button", { name: "Log follow-up" }))
    await fillAndSave(user)
    expect(await screen.findByText("This lead changed. Refresh before trying again.")).toBeInTheDocument()
    expect(screen.queryByText("Saving…")).toBeNull()
    // Recovery re-reads the single-row lookup, then the user can resubmit with the fresh version.
    mocks.loadMyLeadRow.mockResolvedValue(found(2))
    mocks.submitMyLeadCommand.mockResolvedValueOnce({ ok: true, attemptRecorded: true })
    await user.click(await screen.findByRole("button", { name: "Refresh" }))
    await screen.findByText(/Lead refreshed/)
    await user.click(screen.getByRole("button", { name: "Save attempt" }))
    await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2))
    expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toMatchObject({ expectedQueueVersion: 2 })
  })

  it("a server action that rejects ends in the uncertain/reconcile state, not a stuck Saving…", async () => {
    const user = userEvent.setup()
    mocks.submitMyLeadCommand.mockRejectedValue(new Error("response lost"))
    render(<LogFollowUpButton propertyId="lead-1" propertyLabel="1 Main" assigneeId="rep-9" disabledReason={null} viewer={{ userId: "rep-9", orgId: "org-1" }} />)
    await user.click(screen.getByRole("button", { name: "Log follow-up" }))
    await fillAndSave(user)
    expect(await screen.findByText(/original request is preserved for reconciliation/)).toBeInTheDocument()
    expect(screen.queryByText("Saving…")).toBeNull()
    expect(screen.getByRole("button", { name: "Reconcile saved change" })).toBeEnabled()
  })

  it("a save that never answers ends in the uncertain/reconcile state, not a stuck Saving…", async () => {
    const user = userEvent.setup({ delay: null })
    mocks.submitMyLeadCommand.mockImplementation(() => new Promise(() => undefined))
    render(<LogFollowUpButton propertyId="lead-1" propertyLabel="1 Main" assigneeId="rep-9" disabledReason={null} viewer={{ userId: "rep-9", orgId: "org-1" }} />)
    await user.click(screen.getByRole("button", { name: "Log follow-up" }))
    await user.selectOptions(await screen.findByLabelText("External outcome"), "reached")
    fireEvent.change(screen.getByLabelText("When did the outreach occur?"), { target: { value: "2026-09-11T09:00" } })
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      fireEvent.click(screen.getByRole("button", { name: "Save attempt" }))
      await act(async () => { await Promise.resolve() })
      expect(screen.getByText("Saving…")).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(25_001) })
    } finally { vi.useRealTimers() }
    expect(await screen.findByText(/original request is preserved for reconciliation/)).toBeInTheDocument()
    expect(screen.queryByText("Saving…")).toBeNull()
  })

  it("timeout, then a stale replay, then Refresh: the next save sends the refreshed version and succeeds", async () => {
    const user = userEvent.setup({ delay: null })
    mocks.submitMyLeadCommand
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({ ok: false, certainty: "rejected", code: "STALE_STATE", message: "This lead changed. Refresh before trying again." })
      .mockResolvedValueOnce({ ok: true, attemptRecorded: true })
    render(<LogFollowUpButton propertyId="lead-1" propertyLabel="1 Main" assigneeId="rep-9" disabledReason={null} viewer={{ userId: "rep-9", orgId: "org-1" }} />)
    await user.click(screen.getByRole("button", { name: "Log follow-up" }))
    await user.selectOptions(await screen.findByLabelText("External outcome"), "reached")
    fireEvent.change(screen.getByLabelText("When did the outreach occur?"), { target: { value: "2026-09-11T09:00" } })
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      fireEvent.click(screen.getByRole("button", { name: "Save attempt" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(25_001) })
    } finally { vi.useRealTimers() }
    await user.click(await screen.findByRole("button", { name: "Reconcile saved change" })) // replay of the frozen request
    expect(await screen.findByText("Sandra can't save these values. Start over to edit them.")).toBeInTheDocument()
    mocks.loadMyLeadRow.mockResolvedValue(found(2))
    await user.click(await screen.findByRole("button", { name: "Refresh" }))
    await user.click(await screen.findByRole("button", { name: "Start over" }))
    await user.click(screen.getByRole("button", { name: "Save attempt" }))
    await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(3))
    const versions = mocks.submitMyLeadCommand.mock.calls.map((call) => (call[1] as { expectedQueueVersion: number }).expectedQueueVersion)
    expect(versions).toEqual([1, 1, 2])
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it("IDEMPOTENCY_CONFLICT shows the already-saved copy; Refresh re-reads the lead and closes the dialog with no drip step and no second send", async () => {
    const user = userEvent.setup()
    mocks.submitMyLeadCommand.mockResolvedValue({ ok: false, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "This was already saved. Refresh to see it." })
    render(<LogFollowUpButton propertyId="lead-1" propertyLabel="1 Main" assigneeId="rep-9" disabledReason={null} viewer={{ userId: "rep-9", orgId: "org-1" }} />)
    await user.click(screen.getByRole("button", { name: "Log follow-up" }))
    await fillAndSave(user)
    expect(await screen.findByText("This was already saved. Refresh to see it.")).toBeInTheDocument()
    mocks.refresh.mockClear()
    await user.click(await screen.findByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(mocks.refresh).toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Done without a drip" })).toBeNull()
    expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1)
  })

  it("commit then timeout: an unknown replay failure keeps reconciliation and the next replay succeeds once", async () => {
    const user = userEvent.setup({ delay: null })
    mocks.submitMyLeadCommand
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({ ok: false, certainty: "unknown", message: "The update could not be confirmed. Retry with the same form." })
      .mockResolvedValueOnce({ ok: true, duplicate: true, attemptRecorded: true })
    render(<LogFollowUpButton propertyId="lead-1" propertyLabel="1 Main" assigneeId="rep-9" disabledReason={null} viewer={{ userId: "rep-9", orgId: "org-1" }} />)
    await user.click(screen.getByRole("button", { name: "Log follow-up" }))
    await user.selectOptions(await screen.findByLabelText("External outcome"), "reached")
    fireEvent.change(screen.getByLabelText("When did the outreach occur?"), { target: { value: "2026-09-11T09:00" } })
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      fireEvent.click(screen.getByRole("button", { name: "Save attempt" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(25_001) })
    } finally { vi.useRealTimers() }
    await user.click(await screen.findByRole("button", { name: "Reconcile saved change" }))
    // The unknown failure proved nothing: the reconcile path is still there.
    await user.click(await screen.findByRole("button", { name: "Reconcile saved change" }))
    await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(3))
    const calls = mocks.submitMyLeadCommand.mock.calls.map((call) => call[1])
    expect(calls[1]).toEqual(calls[0])
    expect(calls[2]).toEqual(calls[0])
  })

  it("FORBIDDEN keeps reconciliation; Refresh re-reads the row without releasing the payload; the replay succeeds once", async () => {
    const user = userEvent.setup()
    mocks.submitMyLeadCommand
      .mockResolvedValueOnce({ ok: false, certainty: "unknown", code: "FORBIDDEN", message: "This lead is unavailable or you no longer have access." })
      .mockResolvedValueOnce({ ok: true, duplicate: true, attemptRecorded: true })
    render(<LogFollowUpButton propertyId="lead-1" propertyLabel="1 Main" assigneeId="rep-9" disabledReason={null} viewer={{ userId: "rep-9", orgId: "org-1" }} />)
    await user.click(screen.getByRole("button", { name: "Log follow-up" }))
    await fillAndSave(user)
    await user.click(await screen.findByRole("button", { name: "Refresh" }))
    await screen.findByText(/Lead refreshed/)
    expect(screen.getByRole("button", { name: "Reconcile saved change" })).toBeEnabled()
    await user.click(screen.getByRole("button", { name: "Reconcile saved change" }))
    await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2))
    expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toEqual(mocks.submitMyLeadCommand.mock.calls[0][1])
  })

  it("a first save the server rejects as invalid shows its error, stays editable and unfrozen, and a corrected save succeeds", async () => {
    const user = userEvent.setup()
    mocks.submitMyLeadCommand
      .mockResolvedValueOnce({ ok: false, answered: true, certainty: "unknown", message: "The update could not be saved. Check the fields and retry." })
      .mockResolvedValueOnce({ ok: true, attemptRecorded: true })
    render(<LogFollowUpButton propertyId="lead-1" propertyLabel="1 Main" assigneeId="rep-9" disabledReason={null} viewer={{ userId: "rep-9", orgId: "org-1" }} />)
    await user.click(screen.getByRole("button", { name: "Log follow-up" }))
    await fillAndSave(user)
    expect(await screen.findByText("The update could not be saved. Check the fields and retry.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Reconcile saved change" })).toBeNull()
    expect(screen.getByLabelText("Note (optional)")).toBeEnabled()
    fireEvent.change(screen.getByLabelText("When did the outreach occur?"), { target: { value: "2026-09-11T08:00" } })
    await user.click(screen.getByRole("button", { name: "Save attempt" }))
    await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2))
    expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toMatchObject({ idempotencyKey: (mocks.submitMyLeadCommand.mock.calls[0][1] as { idempotencyKey: string }).idempotencyKey })
    expect(await screen.findByRole("button", { name: "Done without a drip" })).toBeInTheDocument()
  })

  it("timeout, then a late ok is ignored, fields stay locked, and Reconcile flows through the normal result path with one attempt", async () => {
    const user = userEvent.setup({ delay: null })
    let lateAnswer!: (value: unknown) => void
    mocks.submitMyLeadCommand
      .mockImplementationOnce(() => new Promise((resolve) => { lateAnswer = resolve }))
      .mockResolvedValueOnce({ ok: true, duplicate: true, attemptRecorded: true })
    render(<LogFollowUpButton propertyId="lead-1" propertyLabel="1 Main" assigneeId="rep-9" disabledReason={null} viewer={{ userId: "rep-9", orgId: "org-1" }} />)
    await user.click(screen.getByRole("button", { name: "Log follow-up" }))
    await user.selectOptions(await screen.findByLabelText("External outcome"), "reached")
    fireEvent.change(screen.getByLabelText("When did the outreach occur?"), { target: { value: "2026-09-11T09:00" } })
    await user.type(screen.getByLabelText("Note (optional)"), "Original note")
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      fireEvent.click(screen.getByRole("button", { name: "Save attempt" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(25_001) })
    } finally { vi.useRealTimers() }
    // The original commits server-side and its late answer arrives: it is ignored.
    await act(async () => { lateAnswer({ ok: true, attemptRecorded: true }) })
    const note = await screen.findByLabelText("Note (optional)")
    expect(note).toBeDisabled()
    expect(note).toHaveValue("Original note")
    expect(screen.queryByRole("button", { name: "Done without a drip" })).toBeNull()
    await user.click(await screen.findByRole("button", { name: "Reconcile saved change" }))
    expect(await screen.findByRole("button", { name: "Done without a drip" })).toBeInTheDocument()
    expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2)
    const calls = mocks.submitMyLeadCommand.mock.calls.map((call) => call[1] as { note?: string })
    expect(calls[1]).toEqual(calls[0])
    expect(calls[1].note).toBe("Original note")
  })
})

