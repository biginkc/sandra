import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"

import type { CallNextSnapshot, TriageSnapshot } from "@/lib/my-leads/call-next"
import type { AcquisitionKpis, AcquisitionRoster, QueueSnapshot } from "@/lib/my-leads/queries"
import { queueRowFixture, stripItem } from "./_components/call-next-test-support"

const mocks = vi.hoisted(() => ({
  routerRefresh: vi.fn(),
  loadMyLeads: vi.fn(),
  loadMyLeadRow: vi.fn(),
  loadMyLeadCallReferences: vi.fn(),
  submitMyLeadCommand: vi.fn(),
  submitMyLeadHandoffDrip: vi.fn(),
  setStripOverride: vi.fn(),
  loadTriage: vi.fn(),
}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.routerRefresh }) }))
vi.mock("@/components/softphone/softphone-provider", () => ({ useOptionalSoftphone: () => null }))
vi.mock("@/components/appointments/book-appointment-popover", () => ({ BookAppointmentPopover: () => null }))
vi.mock("./actions", () => ({
  loadMyLeads: mocks.loadMyLeads,
  loadMyLeadRow: mocks.loadMyLeadRow,
  loadMyLeadsStage: vi.fn(),
  loadMyLeadDetail: vi.fn(),
  loadMyLeadCallReferences: mocks.loadMyLeadCallReferences,
  submitMyLeadCommand: mocks.submitMyLeadCommand,
  submitMyLeadHandoffDrip: mocks.submitMyLeadHandoffDrip,
  changeAcquisitionDesignation: vi.fn(),
  changeAcquisitionSettings: vi.fn(),
}))
vi.mock("./strip-actions", () => ({
  setStripOverride: mocks.setStripOverride,
  loadTriage: mocks.loadTriage,
  loadCallNext: vi.fn(),
}))
vi.mock("@/app/(dashboard)/sequences/actions", () => ({
  listDripChoices: vi.fn(async () => ({ ok: true, data: [] })),
  startDripForLeads: vi.fn(),
}))
vi.mock("./dialpad-actions", () => ({
  verifyDialpadBindingAction: vi.fn(), listDialpadCallTargetsAction: vi.fn(),
  startDialpadCallAction: vi.fn(), getDialpadCallStatusAction: vi.fn(),
  cancelDialpadCallAction: vi.fn(), listRecentDialpadCallsAction: vi.fn(),
}))
vi.mock("./dialpad-recording-actions", () => ({
  closeDialpadRecordingCaptureAction: vi.fn(), getDialpadRecordingBrowserStatusAction: vi.fn(),
  mintDialpadRecordingNextEpochAction: vi.fn(), openDialpadRecordingCaptureAction: vi.fn(),
}))
vi.mock("./rep-sms-composer", () => ({ RepSmsComposer: () => null }))
// A thin queue: the sections themselves are covered elsewhere; this file is about the strip.
vi.mock("./_components/queue", () => ({
  MyLeadsQueue: ({ stages }: { stages: Record<string, { rows: { propertyId: string; address: string; stripReason?: string }[] }> }) => (
    <section aria-label="Mock My Leads queue" data-testid="mock-queue">
      {Object.values(stages).flatMap((page) => page.rows).map((row) => (
        <p key={row.propertyId} data-testid={`section-row-${row.propertyId}`}>
          {row.address}
          {row.stripReason ? ` | ${row.stripReason}` : ""}
        </p>
      ))}
    </section>
  ),
}))

import { MyLeadsClient } from "./client"

const viewer = { userId: "rep-1", orgId: "org-1", isOwner: false }
const roster: AcquisitionRoster = {
  isOwner: false,
  members: [{ id: "rep-1", label: "Maria", role: "member", acquisitionsEnabled: true, active: true, hasHistory: true }],
  settings: { enabled: true, recipientId: "owner-1", revision: 1 },
}
const kpis: AcquisitionKpis = {
  contactWithoutFollowUp: 0, needsOffers: 0, appointmentsOverdue: 0, lastAttemptAt: null, asOf: "2026-10-05T14:00:00Z", missingRecordings: 0, recordingExpectationUnknown: 0, averageTalkSeconds: null, talkTimeSamples: 0, talkTimeUnknown: 0, conversationsOverFiveMinutes: 0,
  attempts: 0, reached: 0, pendingOutcomes: 0, firstCallSamples: 0, firstCallPending: 0, firstCallElapsedSeconds: null,
  appointmentsDue: 0, appointmentsHeld: 0, orgAppointmentsUnattributed: 0, offersSent: 0, staleLeads: 0,
}
const snapshot = (): QueueSnapshot => ({
  stages: {
    not_contacted: {
      rows: [queueRowFixture("section-1", { stage: "not_contacted", address: "1 Section Lane" })],
      totalCount: 1, filteredCount: 1, cursor: null, hasMore: false,
    },
  },
  snapshotAt: "2026-10-05T15:00:00Z",
  nextWarningAt: null,
  search: "",
})
const strip = (over: Partial<CallNextSnapshot> = {}): CallNextSnapshot => ({
  rows: [stripItem("strip-only", "inbound_text"), stripItem("section-1", "appointment_overdue")],
  excluded: [],
  hiddenCount: 0,
  snapshotAt: "2026-10-05T15:00:00Z",
  ...over,
})
const loaded = (s: CallNextSnapshot | null | undefined) => ({ ok: true as const, snapshot: snapshot(), kpis, drips: { active: [], replied: [], repliedCount: 0, counts: {} }, strip: s })

function renderClient(initialStrip: CallNextSnapshot | null, props: Partial<React.ComponentProps<typeof MyLeadsClient>> = {}) {
  return render(
    <MyLeadsClient
      viewer={viewer}
      roster={roster}
      initialMemberId={viewer.userId}
      initialSnapshot={snapshot()}
      initialKpis={kpis}
      initialStrip={initialStrip}
      {...props}
    />,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.loadMyLeads.mockResolvedValue(loaded(strip()))
  mocks.loadMyLeadCallReferences.mockResolvedValue({ ok: true, options: [] })
  mocks.setStripOverride.mockResolvedValue({ ok: true, until: "2026-10-06T05:00:00Z" })
  // The single-row lookup answers for the strip-only lead, which is on no section page.
  mocks.loadMyLeadRow.mockImplementation(async ({ propertyId }: { propertyId: string }) => ({
    ok: true,
    lookup: { status: "found", row: queueRowFixture(propertyId), snapshotAt: "2026-10-05T15:00:00Z" },
  }))
})

describe("MyLeadsClient Call next strip", () => {
  it("renders the strip immediately above the sections, with each reason", () => {
    renderClient(strip())
    const stripEl = screen.getByTestId("call-next-strip")
    const queue = screen.getByTestId("mock-queue")
    expect(stripEl.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(stripEl.parentElement).toBe(queue.parentElement)
    expect(screen.getByTestId("call-next-reason-strip-only")).toHaveTextContent("Texted you 2d ago")
    expect(screen.getByTestId("call-next-reason-section-1")).toHaveTextContent("Callback 2 days overdue")
  })

  it("renders nothing extra when the strip is off: the page is the existing page", () => {
    const { container } = renderClient(null)
    expect(screen.queryByTestId("call-next-strip")).not.toBeInTheDocument()
    expect(screen.getByTestId("section-row-section-1")).toHaveTextContent("1 Section Lane")
    expect(container.querySelector("[data-testid^='call-next']")).toBeNull()
    expect(container.textContent).not.toContain("In Call next")
  })

  it("tags the matching section row with the strip reason and leaves other rows alone", () => {
    renderClient(strip())
    expect(screen.getByTestId("section-row-section-1")).toHaveTextContent("1 Section Lane | Callback 2 days overdue")
  })

  it("Dead / Nurture on a strip-only lead opens the existing handoff dialog", async () => {
    const user = userEvent.setup()
    renderClient(strip())
    await user.click(screen.getByTestId("call-next-menu-strip-only"))
    await user.click(await screen.findByTestId("call-next-action-dead-nurture-strip-only"))
    await waitFor(() => expect(mocks.loadMyLeadRow).toHaveBeenCalledWith({ memberId: "rep-1", propertyId: "strip-only" }))
    expect(await screen.findByLabelText("Handoff reason")).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toHaveTextContent("strip-only Main St")
    // Nothing was written by merely opening it.
    expect(mocks.submitMyLeadHandoffDrip).not.toHaveBeenCalled()
    expect(mocks.submitMyLeadCommand).not.toHaveBeenCalled()
  })

  it("Call on a strip-only lead is routed to the existing call entry (not silently ignored)", async () => {
    const user = userEvent.setup()
    renderClient(strip())
    await user.click(screen.getByTestId("call-next-action-call-strip-only"))
    // No softphone and no Dialpad in this fixture: the existing guard answers.
    expect(await screen.findByRole("alert")).toHaveTextContent("Calling is not enabled.")
  })

  it("Call today saves the override and refreshes the strip", async () => {
    const user = userEvent.setup()
    renderClient(strip())
    mocks.loadMyLeads.mockResolvedValue(
      loaded(strip({ rows: [stripItem("strip-only", "pinned_call_today"), stripItem("section-1", "appointment_overdue")] })),
    )
    await user.click(screen.getByTestId("call-next-menu-strip-only"))
    await user.click(await screen.findByTestId("call-next-action-call-today-strip-only"))
    await waitFor(() => expect(mocks.setStripOverride).toHaveBeenCalledExactlyOnceWith({ memberId: "rep-1", propertyId: "strip-only", action: "call_today" }))
    await waitFor(() => expect(mocks.loadMyLeads).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId("call-next-reason-strip-only")).toHaveTextContent("Pinned: call today"))
  })

  it("Not today saves and the refreshed strip no longer has the lead", async () => {
    const user = userEvent.setup()
    renderClient(strip())
    mocks.loadMyLeads.mockResolvedValue(loaded(strip({ rows: [stripItem("section-1", "appointment_overdue")], hiddenCount: 1 })))
    await user.click(screen.getByTestId("call-next-menu-strip-only"))
    await user.click(await screen.findByTestId("call-next-action-not-today-strip-only"))
    await waitFor(() => expect(mocks.setStripOverride).toHaveBeenCalledWith(expect.objectContaining({ action: "not_today" })))
    await waitFor(() => expect(screen.queryByTestId("call-next-row-strip-only")).not.toBeInTheDocument())
    expect(screen.getByTestId("call-next-hidden")).toHaveTextContent("1 hidden today")
  })

  it("shows the error and keeps the strip when saving an override fails", async () => {
    const user = userEvent.setup()
    mocks.setStripOverride.mockResolvedValue({ ok: false, message: "The change could not be saved. Please retry." })
    renderClient(strip())
    await user.click(screen.getByTestId("call-next-menu-strip-only"))
    await user.click(await screen.findByTestId("call-next-action-call-today-strip-only"))
    expect(await screen.findByText("The change could not be saved. Please retry.")).toBeInTheDocument()
    expect(mocks.loadMyLeads).not.toHaveBeenCalled()
    expect(screen.getByTestId("call-next-row-strip-only")).toBeInTheDocument()
  })

  it("a failed strip read on refresh keeps the last strip and the sections working; null (flag off) removes it", async () => {
    const user = userEvent.setup()
    renderClient(strip())
    mocks.loadMyLeads.mockResolvedValueOnce(loaded(undefined))
    await user.click(screen.getByTestId("call-next-menu-strip-only"))
    await user.click(await screen.findByTestId("call-next-action-call-today-strip-only"))
    await waitFor(() => expect(mocks.loadMyLeads).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId("call-next-strip")).toBeInTheDocument()
    expect(screen.getByTestId("section-row-section-1")).toBeInTheDocument()
    mocks.loadMyLeads.mockResolvedValueOnce(loaded(null))
    await user.click(screen.getByTestId("call-next-menu-strip-only"))
    await user.click(await screen.findByTestId("call-next-action-not-today-strip-only"))
    await waitFor(() => expect(screen.queryByTestId("call-next-strip")).not.toBeInTheDocument())
    expect(screen.getByTestId("section-row-section-1")).toBeInTheDocument()
  })

  it("an owner looking at a rep's strip can read it but not act on it", () => {
    renderClient(strip(), { viewer: { ...viewer, userId: "owner-1", isOwner: true }, initialMemberId: "rep-1" })
    expect(screen.getByTestId("call-next-action-call-strip-only")).toBeDisabled()
    expect(screen.getByTestId("call-next-menu-strip-only")).toBeDisabled()
  })

  it("the triage chip loads the untouched list, pages it, and rows share the strip actions", async () => {
    const user = userEvent.setup()
    const page = (ids: string[], cursor: TriageSnapshot["cursor"]): TriageSnapshot => ({
      rows: ids.map((id) => ({ propertyId: id, lastTouchAt: null, row: queueRowFixture(id) })),
      totalCount: 3,
      cursor,
    })
    mocks.loadTriage
      .mockResolvedValueOnce({ ok: true, triage: page(["t1", "t2"], { touch: null, property: "t2" }) })
      .mockResolvedValueOnce({ ok: true, triage: page(["t3"], null) })
    renderClient(strip())
    await user.click(screen.getByTestId("call-next-triage-chip"))
    expect(await screen.findByTestId("call-next-row-t1")).toBeInTheDocument()
    expect(mocks.loadTriage).toHaveBeenCalledWith("rep-1", null)
    await user.click(screen.getByTestId("call-next-triage-more"))
    expect(await screen.findByTestId("call-next-row-t3")).toBeInTheDocument()
    expect(mocks.loadTriage).toHaveBeenLastCalledWith("rep-1", { touch: null, property: "t2" })
    expect(within(screen.getByTestId("call-next-triage")).getAllByTestId(/^call-next-row-/)).toHaveLength(3)
    // Dead / Nurture on a triage-only lead opens the same handoff dialog.
    await user.click(screen.getByTestId("call-next-menu-t3"))
    await user.click(await screen.findByTestId("call-next-action-dead-nurture-t3"))
    expect(await screen.findByLabelText("Handoff reason")).toBeInTheDocument()
    // Closing the chip hides the list without another read.
    mocks.loadTriage.mockClear()
    await user.keyboard("{Escape}")
    await user.click(screen.getByTestId("call-next-triage-chip"))
    expect(screen.queryByTestId("call-next-triage")).not.toBeInTheDocument()
    expect(mocks.loadTriage).not.toHaveBeenCalled()
  })

  it("reports a triage failure inside the chip without touching the strip", async () => {
    const user = userEvent.setup()
    mocks.loadTriage.mockResolvedValue({ ok: false, message: "The triage list could not load." })
    renderClient(strip())
    await user.click(screen.getByTestId("call-next-triage-chip"))
    expect(await screen.findByText("The triage list could not load.")).toBeInTheDocument()
    expect(screen.getByTestId("call-next-row-strip-only")).toBeInTheDocument()
  })
})
