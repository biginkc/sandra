vi.mock("@/lib/sequences/drip-progress", () => ({ listDripProgress: vi.fn(async () => []) }))
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }))
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { EMPTY_CALL_STATE } from "@/lib/my-leads/call-state"
import type { AcquisitionKpis, AcquisitionRoster } from "@/lib/my-leads/queries"
import { queueRowFixture } from "./_components/call-next-test-support"

const mocks = vi.hoisted(() => ({
  routerRefresh: vi.fn(),
  routerReplace: vi.fn(),
  loadMyLeads: vi.fn(),
  loadMyLeadRow: vi.fn(),
  loadMyLeadDetail: vi.fn(),
  loadMyLeadCallReferences: vi.fn(),
  submitMyLeadCommand: vi.fn(),
  loadWorkPage: vi.fn(),
  loadWorkFacts: vi.fn(),
  pinLead: vi.fn(),
  dismissBroken: vi.fn(),
  loadUnifiedKpis: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.routerRefresh, replace: mocks.routerReplace }),
}))
vi.mock("@/components/softphone/softphone-provider", () => ({ useOptionalSoftphone: () => null }))
vi.mock("@/components/appointments/book-appointment-popover", () => ({
  BookAppointmentPopover: ({ onBooked }: { onBooked: () => void }) => <button type="button" onClick={onBooked}>Booked</button>,
}))
vi.mock("./actions", () => ({
  loadMyLeads: mocks.loadMyLeads,
  loadMyLeadRow: mocks.loadMyLeadRow,
  loadMyLeadsStage: vi.fn(),
  loadMyLeadDetail: mocks.loadMyLeadDetail,
  loadMyLeadCallReferences: mocks.loadMyLeadCallReferences,
  submitMyLeadCommand: mocks.submitMyLeadCommand,
  submitMyLeadHandoffDrip: vi.fn(),
  changeAcquisitionDesignation: vi.fn(),
  changeAcquisitionSettings: vi.fn(),
}))
vi.mock("./unified-actions", () => ({
  loadWorkPage: mocks.loadWorkPage,
  loadWorkFacts: mocks.loadWorkFacts,
  pinLead: mocks.pinLead,
  dismissBroken: mocks.dismissBroken,
  loadUnifiedKpis: mocks.loadUnifiedKpis,
}))
vi.mock("@/app/(dashboard)/sequences/actions", () => ({
  listDripChoices: vi.fn(async () => ({ ok: true, data: [] })),
  startDripForLeads: vi.fn(),
  changeDripAction: vi.fn(),
}))
vi.mock("./dialpad-actions", () => ({
  dialLeadAction: vi.fn(),
  getDialpadCallStatusAction: vi.fn(async () => ({ ok: false, code: "not_configured", message: "" })),
  cancelDialpadCallAction: vi.fn(),
  ensureDialpadBindingAction: vi.fn(),
}))
vi.mock("./call-state-actions", () => ({
  pollMyLeadsCallStateAction: vi.fn(async () => ({ ok: true, state: EMPTY_CALL_STATE })),
  acknowledgeCallPromptAction: vi.fn(async () => ({ ok: true, status: "acknowledged" })),
}))
vi.mock("./rep-sms-composer", () => ({ RepSmsComposer: () => null }))
// The old queue, stubbed: its presence means the flag-off page renders.
vi.mock("./_components/queue", () => ({ MyLeadsQueue: () => <section aria-label="Mock My Leads queue" /> }))

import { renderWithDialpad } from "@/components/dialpad/test-shell"
import { MyLeadsClient } from "./client"
import type { UnifiedInitial, WorkFacts, WorkQuery } from "./unified/contract"
import { workFacts } from "./unified/test-support"
import { Q, makeServer } from "./unified/work-queue-fixtures"

const viewer = { userId: "rep-1", orgId: "org-1", isOwner: false }
const member = (id: string, label: string) => ({ id, label, role: "member", acquisitionsEnabled: true, active: true, hasHistory: true })
const roster: AcquisitionRoster = { isOwner: false, members: [member("rep-1", "Maria")], settings: { enabled: true, recipientId: null, revision: 1 } }
const ownerRoster: AcquisitionRoster = { isOwner: true, members: [member("rep-1", "Maria"), member("rep-2", "Sam")], settings: { enabled: true, recipientId: null, revision: 1 } }

const kpis: AcquisitionKpis = {
  contactWithoutFollowUp: 2, needsOffers: 3, appointmentsOverdue: 4, lastAttemptAt: null, asOf: "2026-10-14T14:00:00Z", missingRecordings: 1,
  recordingExpectationUnknown: 0, averageTalkSeconds: 180, talkTimeSamples: 1, talkTimeUnknown: 0, conversationsOverFiveMinutes: 0,
  attempts: 6, reached: 2, pendingOutcomes: 0, firstCallSamples: 1, firstCallPending: 0, firstCallElapsedSeconds: 120, appointmentsDue: 0,
  appointmentsHeld: 0, orgAppointmentsUnattributed: 0, offersSent: 1, staleLeads: 0,
}

const lead = (id: string, reason: WorkFacts["reason"], rowNo: string, headline: Record<string, unknown> = {}, over: Partial<WorkFacts> = {}) =>
  workFacts(reason, rowNo, headline, { propertyId: id, row: queueRowFixture(id, { homeownerName: `Owner ${id}`, address: `${id} Main St` }), ...over })

function fake() {
  const server = makeServer(25)
  server.add("u1", lead("u1", "due", "4", { at: "2026-10-14T14:00:00Z", soon: false }))
  server.add("u2", lead("u2", "new_lead", "3", { assignedAt: "2026-10-14T15:00:00Z", firstCallOverdue: false }, { stage: "not_contacted" }))
  mocks.loadWorkPage.mockImplementation(async ({ query }: { query: WorkQuery }) => ({ ok: true, page: server.page(query) }))
  mocks.loadWorkFacts.mockImplementation(async ({ ids }: { ids: string[] }) => ({ ok: true, facts: server.facts(ids) }))
  mocks.loadMyLeadRow.mockImplementation(async ({ propertyId }: { propertyId: string }) => ({
    ok: true,
    lookup: { status: "found", row: queueRowFixture(propertyId, { homeownerName: `Owner ${propertyId}`, address: `${propertyId} Main St` }), snapshotAt: "2026-10-14T18:00:00Z" },
  }))
  mocks.loadMyLeadCallReferences.mockResolvedValue({ ok: true, options: [] })
  mocks.loadMyLeadDetail.mockResolvedValue({ ok: true, detail: { groups: {} } })
  mocks.loadUnifiedKpis.mockResolvedValue({ ok: true, kpis })
  mocks.pinLead.mockResolvedValue({ ok: true, pinnedAt: null })
  mocks.dismissBroken.mockResolvedValue({ ok: true })
  return server
}

function renderUnified(over: Partial<React.ComponentProps<typeof MyLeadsClient>> = {}, server = fake(), initial?: Partial<UnifiedInitial>, rosterIn = roster, viewerIn = viewer) {
  const unified: UnifiedInitial = { ...server.initial(Q()), kpis, ...initial }
  const view = renderWithDialpad(
    <MyLeadsClient
      viewer={viewerIn}
      roster={rosterIn}
      initialMemberId={viewerIn.userId}
      initialSnapshot={null}
      initialKpis={null}
      unified={unified}
      {...over}
    />,
  )
  return { server, ...view }
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  window.history.replaceState(null, "", "/my-leads")
})

describe("MyLeadsClient with the unified queue on", () => {
  it("renders the new queue and the six activity tiles, and never runs the old reads", async () => {
    vi.useFakeTimers()
    try {
      renderUnified()
      expect(screen.getByRole("tablist", { name: "Work queue" })).toBeInTheDocument()
      expect(screen.getByTestId("work-row-u1")).toBeInTheDocument()
      expect(screen.getByTestId("work-row-u2")).toBeInTheDocument()
      expect(screen.queryByLabelText("Mock My Leads queue")).not.toBeInTheDocument()
      // No Call next strip, no attention tiles.
      expect(screen.queryByText(/Call next/i)).not.toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(mocks.loadMyLeads).not.toHaveBeenCalled()
      expect(mocks.loadMyLeadRow).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
      expect(mocks.loadMyLeads).not.toHaveBeenCalled()
      // The unified queue's own 30 s background read did run.
      expect(mocks.loadWorkPage).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("an action button reaches the existing dialog flow: Log attempt opens the attempt dialog", async () => {
    const user = userEvent.setup()
    renderUnified()
    await user.click(screen.getByTestId("work-row-toggle-u1"))
    await user.click(await screen.findByTestId("work-row-log-attempt-u1"))
    expect(await screen.findByRole("dialog", { name: /Log an attempt/i })).toBeVisible()
    // The lead was resolved through the existing single-row lookup, not a list copy.
    expect(mocks.loadMyLeadRow).toHaveBeenCalledWith({ memberId: "rep-1", propertyId: "u1" })
    expect(mocks.loadMyLeads).not.toHaveBeenCalled()
  })

  it("re-reads the lead (not the old queue) after a workflow commits", async () => {
    const user = userEvent.setup()
    renderUnified()
    await user.click(screen.getByTestId("work-row-toggle-u1"))
    await user.click(await screen.findByTestId("work-row-more-u1"))
    await user.click(await screen.findByTestId("work-row-menu-schedule-next-step-u1"))
    await user.click(await screen.findByRole("button", { name: "Booked" }))
    await waitFor(() => expect(mocks.loadWorkFacts).toHaveBeenCalledWith({ memberId: "rep-1", ids: ["u1"] }))
    expect(mocks.loadMyLeads).not.toHaveBeenCalled()
  })

  it("keeps Manage Acquisitions for an owner and the rep selector reloads the unified list for that rep", async () => {
    const user = userEvent.setup()
    renderUnified({}, fake(), undefined, ownerRoster, { userId: "rep-1", orgId: "org-1", isOwner: true })
    expect(screen.getByText("Manage Acquisitions")).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText("Acquisitions member"), "rep-2")
    await waitFor(() => expect(mocks.loadWorkPage).toHaveBeenCalledWith({ memberId: "rep-2", query: Q() }))
    await waitFor(() => expect(mocks.loadUnifiedKpis).toHaveBeenCalledWith({ memberId: "rep-2" }))
    expect(mocks.loadMyLeads).not.toHaveBeenCalled()
    // Viewing another rep is read-only.
    await user.click(await screen.findByTestId("work-row-toggle-u1"))
    expect(await screen.findByTestId("work-row-call-u1")).toBeDisabled()
  })

  it("a deep link opens its row, and the first change of view drops ?lead= from the URL", async () => {
    const user = userEvent.setup()
    const server = fake()
    const pinned = lead("u2", "new_lead", "3", { assignedAt: "2026-10-14T15:00:00Z", firstCallOverdue: false }, { stage: "not_contacted" })
    window.history.replaceState(null, "", "/my-leads?lead=u2")
    const push = vi.spyOn(window.history, "pushState")
    renderUnified(
      { focus: { propertyId: "u2", memberId: "rep-1", notice: null, pin: pinned.row } },
      server,
      { pinned },
    )
    expect(screen.getByTestId("work-row-u2")).toHaveAttribute("data-expanded", "true")
    expect(document.querySelector("[data-lead-id]")?.getAttribute("data-lead-id")).toBe("u2")
    await user.click(screen.getByTestId("work-tab-waiting"))
    await waitFor(() => expect(push).toHaveBeenCalledWith(null, "", "/my-leads?tab=waiting"))
    expect(window.location.search).toBe("?tab=waiting")
    expect(mocks.routerReplace).not.toHaveBeenCalled()
    push.mockRestore()
  })

  it("tab, chip and page changes push history entries; typing in search only rewrites the current one", async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, "", "/my-leads")
    renderUnified({}, fake())
    const push = vi.spyOn(window.history, "pushState")
    const replace = vi.spyOn(window.history, "replaceState")
    await user.click(screen.getByTestId("work-tab-waiting"))
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    expect(replace).not.toHaveBeenCalled()
    await user.click(screen.getByTestId("work-search-open"))
    await user.type(screen.getByTestId("work-search-input"), "elm")
    await waitFor(() => expect(window.location.search).toBe("?tab=waiting&q=elm"))
    expect(push).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith(null, "", "/my-leads?tab=waiting&q=elm")
    push.mockRestore()
    replace.mockRestore()
  })

  it("Back restores the previous view from the URL without adding a history entry", async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, "", "/my-leads")
    const server = fake()
    renderUnified({}, server)
    await user.click(screen.getByTestId("work-tab-waiting"))
    await waitFor(() => expect(window.location.search).toBe("?tab=waiting"))
    const push = vi.spyOn(window.history, "pushState")
    const lengthBefore = window.history.length
    window.history.back()
    await waitFor(() => expect(window.location.search).toBe(""))
    await waitFor(() => expect(screen.getByTestId("work-tab-needs_attention")).toHaveAttribute("aria-selected", "true"))
    expect(push).not.toHaveBeenCalled()
    expect(window.history.length).toBe(lengthBefore)
    push.mockRestore()
  })
})

describe("MyLeadsClient with the unified queue off", () => {
  it("renders today's page when unified is omitted or null", () => {
    mocks.loadMyLeadRow.mockResolvedValue({ ok: true, lookup: { status: "unavailable", reason: "not_found" } })
    const snapshot = { stages: {}, snapshotAt: "2026-10-14T14:00:00Z", nextWarningAt: null, search: "" }
    for (const unified of [undefined, null] as const) {
      const view = render(
        <MyLeadsClient
          viewer={viewer}
          roster={roster}
          initialMemberId="rep-1"
          initialSnapshot={snapshot as never}
          initialKpis={kpis}
          unified={unified}
        />,
      )
      expect(screen.getByLabelText("Mock My Leads queue")).toBeInTheDocument()
      expect(screen.queryByRole("tablist", { name: "Work queue" })).not.toBeInTheDocument()
      view.unmount()
    }
    expect(mocks.loadWorkPage).not.toHaveBeenCalled()
  })
})

// The drip picker reads over GET; route it through the mocked server action so existing fixtures apply.
vi.mock("@/lib/sequences/drip-choices-client", async () => {
  const actions = await import("@/app/(dashboard)/sequences/actions");
  return { fetchDripChoices: () => actions.listDripChoices() };
});
