import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"

const mocks = vi.hoisted(() => ({
  routerRefresh: vi.fn(),
  loadMyLeads: vi.fn(),
  loadMyLeadCallReferences: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.routerRefresh }),
}))

vi.mock("@/components/softphone/softphone-provider", () => ({
  useOptionalSoftphone: () => null,
}))

vi.mock("@/components/appointments/book-appointment-popover", () => ({
  BookAppointmentPopover: () => null,
}))

vi.mock("./actions", () => ({
  loadMyLeads: mocks.loadMyLeads,
  loadMyLeadsStage: vi.fn(),
  loadMyLeadDetail: vi.fn(),
  loadMyLeadCallReferences: mocks.loadMyLeadCallReferences,
  submitMyLeadCommand: vi.fn(),
  changeAcquisitionDesignation: vi.fn(),
  changeAcquisitionSettings: vi.fn(),
}))

vi.mock("./_components/queue", () => ({
  MyLeadsQueue: ({
    stages,
    search,
    onSearchChange,
    canSelectRep,
    selectedRepId,
    repOptions,
    onRepChange,
    selectedPeriod,
    selectedDateRange,
    onPeriodChange,
    onDateRangeChange,
    onStageAction,
    kpis: tiles,
  }: {
    kpis: { attempts: number }
    stages: { not_contacted?: { rows: Array<{ address: string; propertyId: string }> } }
    search: string
    onStageAction: (kind: string, row: { propertyId: string }) => void
    onSearchChange: (value: string) => void
    canSelectRep: boolean
    selectedRepId: string
    repOptions: Array<{ id: string; label: string }>
    onRepChange: (value: string) => void
    selectedPeriod: string
    selectedDateRange: { startDate: string; endDate: string } | null
    onPeriodChange: (period: string) => void
    onDateRangeChange: (range: { startDate: string; endDate: string }) => void
  }) => {
    const [expanded, setExpanded] = React.useState(false)
    const row = stages.not_contacted?.rows[0]
    return (
      <section aria-label="Mock My Leads queue">
        <span data-testid="attempt-count">{tiles.attempts}</span>
        <button onClick={() => row && onStageAction("log-attempt", row)}>Log attempt</button>
        <span data-testid="queue-address">{row?.address}</span>
        <input aria-label="Search My Leads" value={search} onChange={(event) => onSearchChange(event.target.value)} />
        {canSelectRep && (
          <select aria-label="Acquisitions member" value={selectedRepId} onChange={(event) => onRepChange(event.target.value)}>
            {repOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        )}
        <select
          aria-label="KPI period"
          value={selectedPeriod}
          onChange={(event) => onPeriodChange(event.target.value)}
        >
          <option value="today">Today</option>
          <option value="custom">Custom range</option>
        </select>
        {selectedPeriod === "custom" && (
          <>
            <input
              aria-label="KPI start date"
              type="date"
              value={selectedDateRange?.startDate || ""}
              onChange={(event) =>
                onDateRangeChange({
                  startDate: event.target.value,
                  endDate: selectedDateRange?.endDate || "",
                })
              }
            />
            <input
              aria-label="KPI end date"
              type="date"
              value={selectedDateRange?.endDate || ""}
              onChange={(event) =>
                onDateRangeChange({
                  startDate: selectedDateRange?.startDate || "",
                  endDate: event.target.value,
                })
              }
            />
          </>
        )}
        <button type="button" onClick={() => setExpanded(true)}>
          Expand details
        </button>
        {expanded && <div data-testid="mounted-detail">Details remain mounted</div>}
      </section>
    )
  },
}))

vi.mock("./_components/readiness-dialog", () => ({
  AcquisitionReadinessDialog: () => null,
}))
vi.mock("./_components/offer-dialog", () => ({
  AcquisitionOfferDialog: () => null,
}))
vi.mock("./_components/lifecycle-dialog", () => ({
  AcquisitionLifecycleDialog: () => null,
}))

import type { AcquisitionKpis, AcquisitionRoster, QueueSnapshot } from "@/lib/my-leads/queries"
import { MyLeadsClient } from "./client"

const viewer = {
  userId: "rep-1",
  orgId: "org-1",
  isOwner: false,
}

const roster: AcquisitionRoster = {
  isOwner: false,
  members: [
    {
      id: "rep-1",
      label: "Maria",
      role: "member",
      acquisitionsEnabled: true,
      active: true,
      hasHistory: true,
    },
  ],
  settings: { enabled: true, recipientId: null, revision: 1 },
}

const kpis: AcquisitionKpis = {
  attempts: 1,
  reached: 1,
  pendingOutcomes: 0,
  firstCallSamples: 1,
  firstCallPending: 0,
  firstCallElapsedSeconds: 120,
  appointmentsDue: 0,
  appointmentsHeld: 0,
  orgAppointmentsUnattributed: 0,
  offersSent: 0,
  staleLeads: 0,
}

function snapshot(address: string): QueueSnapshot {
  return {
    stages: {
      not_contacted: {
        rows: [
          {
            propertyId: "property-1",
            stage: "not_contacted",
            queueVersion: 1,
            sharedStatus: "new_lead",
            assignmentEpisodeId: "episode-1",
            assignedAt: "2026-09-11T14:00:00.000Z",
            initializedAt: "2026-09-11T14:00:00.000Z",
            episodeKind: "live",
            clockEligible: true,
            firstCallAt: null,
            stageEnteredAt: null,
            address,
            city: "Kansas City",
            state: "MO",
            homeownerName: "Fixture Homeowner",
            phone: "555-0100",
            contactId: "contact-1",
            phones: ["555-0100"],
            contactDnc: false,
            temperature: null,
            motivationKind: null,
            motivationText: null,
            warningReasons: [],
            nextStepAt: null,
            nextStepType: null,
            offer: null,
            attemptsCount: 0,
          },
        ],
        totalCount: 1,
        filteredCount: 1,
        cursor: null,
        hasMore: false,
      },
    },
    snapshotAt: "2026-09-11T14:00:00.000Z",
    nextWarningAt: null,
    search: "",
  }
}

function renderClient(initialSnapshot: QueueSnapshot, initialKpis = kpis) {
  return render(
    <MyLeadsClient
      viewer={viewer}
      roster={roster}
      initialMemberId={viewer.userId}
      initialSnapshot={initialSnapshot}
      initialKpis={initialKpis}
    />,
  )
}

describe("MyLeadsClient", () => {
  beforeEach(() => {
    mocks.loadMyLeads.mockReset()
    mocks.loadMyLeadCallReferences.mockReset()
  })

  it("updates the visible check time every 30 seconds even when attempts do not change", async () => {
    vi.useFakeTimers()
    const initial = snapshot("106 Fixture Lane")
    mocks.loadMyLeads.mockResolvedValueOnce({ ok: true, snapshot: { ...initial, snapshotAt: "2026-09-11T14:00:30.000Z" }, kpis })
    mocks.loadMyLeads.mockResolvedValueOnce({ ok: true, snapshot: { ...initial, snapshotAt: "2026-09-11T14:01:00.000Z" }, kpis })
    const view = renderClient(initial)
    try {
      expect(screen.getByText(/Checks for updates every 30 seconds/)).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(29_999) })
      expect(mocks.loadMyLeads).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(view.container.querySelector("time")).toHaveTextContent("9:00:30 AM CDT")
      expect(screen.getByTestId("attempt-count")).toHaveTextContent("1")
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(view.container.querySelector("time")).toHaveTextContent("9:01:00 AM CDT")
      expect(mocks.loadMyLeads).toHaveBeenCalledTimes(2)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it.each(["result", "rejection"])("marks stale counts and resumes polling after a refresh %s", async mode => {
    vi.useFakeTimers()
    const initial = snapshot("106 Fixture Lane")
    if (mode === "result") mocks.loadMyLeads.mockResolvedValueOnce({ ok: false, message: "Sign in to view My Leads." })
    else mocks.loadMyLeads.mockRejectedValueOnce(new Error("Unexpected server response"))
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: { ...snapshot("Updated Lane"), snapshotAt: "2026-09-11T14:01:00.000Z" }, kpis: { ...kpis, attempts: 8 } })
    const view = renderClient(initial, { ...kpis, attempts: 7 })
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(screen.getByRole("alert")).toHaveTextContent("Displayed counts may be out of date")
      expect(screen.getByRole("button", { name: "Reload and reconnect" })).toBeInTheDocument()
      expect(screen.getByTestId("queue-address")).toHaveTextContent("106 Fixture Lane")
      expect(screen.getByTestId("attempt-count")).toHaveTextContent("7")
      expect(view.container.querySelector("time")).toHaveAttribute("datetime", initial.snapshotAt)
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(mocks.loadMyLeads).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(screen.getByTestId("queue-address")).toHaveTextContent("Updated Lane")
      expect(screen.getByTestId("attempt-count")).toHaveTextContent("8")
      expect(view.container.querySelector("time")).toHaveAttribute("datetime", "2026-09-11T14:01:00.000Z")
      view.unmount()
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(mocks.loadMyLeads).toHaveBeenCalledTimes(2)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it("shows lookup loading, then enables the actual call selector", async () => {
    const user = userEvent.setup()
    let resolve!: (value: unknown) => void
    mocks.loadMyLeadCallReferences.mockReturnValue(new Promise(r => { resolve = r }))
    renderClient(snapshot("106 Fixture Lane"))
    await user.click(screen.getByRole("button", { name: "Log attempt" }))
    expect(screen.getByRole("status")).toHaveTextContent("Loading Sandra calls")
    expect(screen.getByRole("option", { name: "Sandra" })).toBeDisabled()
    resolve({ ok: true, options: [{ id: "call-1", label: "Today at 9 AM" }] })
    await waitFor(() => expect(screen.getByRole("option", { name: "Sandra" })).toBeEnabled())
    await user.selectOptions(screen.getByLabelText("Source"), "sandra")
    expect(screen.getByLabelText("Sandra call")).toHaveValue("call-1")
  })

  it.each(["result", "rejection"])("retries a lookup %s inside the dialog without losing the note", async mode => {
    const user = userEvent.setup()
    if (mode === "result") mocks.loadMyLeadCallReferences.mockResolvedValueOnce({ ok: false, message: "Failed" })
    else mocks.loadMyLeadCallReferences.mockRejectedValueOnce(new Error("Network"))
    mocks.loadMyLeadCallReferences.mockResolvedValueOnce({ ok: true, options: [{ id: "call-1", label: "Today at 9 AM" }] })
    renderClient(snapshot("106 Fixture Lane"))
    await user.click(screen.getByRole("button", { name: "Log attempt" }))
    await user.type(screen.getByLabelText("Note (optional)"), "Keep this note")
    await user.click(await screen.findByRole("button", { name: "Retry loading Sandra calls" }))
    await waitFor(() => expect(screen.getByRole("option", { name: "Sandra" })).toBeEnabled())
    expect(screen.getByLabelText("Note (optional)")).toHaveValue("Keep this note")
    expect(mocks.loadMyLeadCallReferences).toHaveBeenCalledTimes(2)
  })

  it("ignores a stale lookup after closing and reopening the same lead", async () => {
    const user = userEvent.setup()
    let resolveOld!: (value: unknown) => void
    mocks.loadMyLeadCallReferences.mockReturnValueOnce(new Promise(r => { resolveOld = r }))
    mocks.loadMyLeadCallReferences.mockResolvedValueOnce({ ok: true, options: [{ id: "new-call", label: "Current call" }] })
    renderClient(snapshot("106 Fixture Lane"))
    await user.click(screen.getByRole("button", { name: "Log attempt" }))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await user.click(screen.getByRole("button", { name: "Log attempt" }))
    await user.selectOptions(screen.getByLabelText("Source"), "sandra")
    expect(screen.getByLabelText("Sandra call")).toHaveValue("new-call")
    resolveOld({ ok: true, options: [{ id: "old-call", label: "Stale call" }] })
    await waitFor(() => expect(screen.getByLabelText("Sandra call")).toHaveValue("new-call"))
    expect(screen.queryByRole("option", { name: "Stale call" })).not.toBeInTheDocument()
  })

  it("preserves expanded queue details when router refresh supplies new initial props", async () => {
    const user = userEvent.setup()
    const initialSnapshot = snapshot("106 Fixture Lane")
    const { rerender } = renderClient(initialSnapshot)

    await user.click(screen.getByRole("button", { name: "Expand details" }))
    expect(screen.getByTestId("mounted-detail")).toHaveTextContent("Details remain mounted")

    rerender(
      <MyLeadsClient
        viewer={viewer}
        roster={roster}
        initialMemberId={viewer.userId}
        initialSnapshot={{ ...initialSnapshot, snapshotAt: "2026-09-11T14:01:00.000Z" }}
        initialKpis={{ ...kpis, attempts: 2 }}
      />,
    )

    expect(screen.getByTestId("queue-address")).toHaveTextContent("106 Fixture Lane")
    expect(screen.getByTestId("mounted-detail")).toHaveTextContent("Details remain mounted")
    expect(mocks.loadMyLeads).not.toHaveBeenCalled()
  })

  it("keeps the queue and date controls mounted until a custom range is complete", async () => {
    const user = userEvent.setup()
    const initialSnapshot = snapshot("106 Fixture Lane")
    mocks.loadMyLeads.mockResolvedValue({
      ok: true as const,
      snapshot: initialSnapshot,
      kpis,
    })
    renderClient(initialSnapshot)

    await user.selectOptions(screen.getByRole("combobox", { name: "KPI period" }), "custom")
    expect(screen.getByTestId("queue-address")).toHaveTextContent("106 Fixture Lane")
    expect(screen.getByLabelText("KPI start date")).toBeInTheDocument()
    expect(mocks.loadMyLeads).not.toHaveBeenCalled()
    window.dispatchEvent(new Event("focus"))
    expect(mocks.loadMyLeads).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText("KPI start date"), "2026-09-01")
    expect(mocks.loadMyLeads).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText("KPI end date"), "2026-09-11")
    await waitFor(() => expect(mocks.loadMyLeads).toHaveBeenCalledOnce())
    expect(mocks.loadMyLeads).toHaveBeenCalledWith({
      memberId: "rep-1",
      search: "",
      period: "custom",
      startDate: "2026-09-01",
      endDate: "2026-09-11",
    })
  })

  it("keeps the search control focused while its filtered queue refreshes", async () => {
    const user = userEvent.setup()
    const initialSnapshot = snapshot("106 Fixture Lane")
    mocks.loadMyLeads.mockResolvedValue({
      ok: true as const,
      snapshot: { ...initialSnapshot, search: "abc" },
      kpis,
    })
    renderClient(initialSnapshot)

    const input = screen.getByRole("textbox", { name: "Search My Leads" })
    await user.type(input, "abc")

    expect(input).toHaveValue("abc")
    expect(input).toHaveFocus()
    await waitFor(() => expect(mocks.loadMyLeads).toHaveBeenCalledWith({
      memberId: "rep-1",
      search: "abc",
      period: "today",
      startDate: undefined,
      endDate: undefined,
    }))
  })

  it("clears the prior rep queue before loading a changed rep scope", async () => {
    const user = userEvent.setup()
    const ownerViewer = { ...viewer, userId: "owner-1", isOwner: true }
    const ownerRoster: AcquisitionRoster = {
      ...roster,
      isOwner: true,
      members: [
        ...roster.members,
        { id: "rep-2", label: "Other rep", role: "member", acquisitionsEnabled: true, active: true, hasHistory: true },
      ],
    }
    mocks.loadMyLeads.mockImplementation(() => new Promise(() => undefined))
    const initialSnapshot = snapshot("Rep one Fixture Lane")
    render(
      <MyLeadsClient
        viewer={ownerViewer}
        roster={ownerRoster}
        initialMemberId="rep-1"
        initialSnapshot={initialSnapshot}
        initialKpis={kpis}
      />,
    )

    await user.selectOptions(screen.getByRole("combobox", { name: "Acquisitions member" }), "rep-2")

    expect(screen.getByRole("status")).toHaveTextContent("Loading My Leads…")
    expect(screen.queryByTestId("queue-address")).not.toBeInTheDocument()
  })
})
