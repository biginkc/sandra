import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  loadMyLeads: vi.fn(),
  loadMyLeadRow: vi.fn(),
  loadMyLeadsStage: vi.fn(),
  loadMyLeadDetail: vi.fn(),
  submitMyLeadCommand: vi.fn(),
}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }) }))
vi.mock("@/components/softphone/softphone-provider", () => ({ useOptionalSoftphone: () => null }))
vi.mock("@/components/appointments/book-appointment-popover", () => ({ BookAppointmentPopover: () => null }))
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ listDripChoices: vi.fn(async () => ({ ok: true, data: [] })), startDripForLeads: vi.fn() }))
vi.mock("./actions", () => ({
  loadMyLeads: mocks.loadMyLeads, loadMyLeadRow: mocks.loadMyLeadRow, loadMyLeadsStage: mocks.loadMyLeadsStage, loadMyLeadDetail: mocks.loadMyLeadDetail,
  loadMyLeadCallReferences: vi.fn(async () => ({ ok: true, options: [] })),
  submitMyLeadCommand: mocks.submitMyLeadCommand, submitMyLeadHandoffDrip: vi.fn(), changeAcquisitionDesignation: vi.fn(), changeAcquisitionSettings: vi.fn(),
}))
vi.mock("./rep-sms-settings", () => ({ RepSmsSettings: () => null }))
vi.mock("./rep-sms-composer", () => ({ RepSmsComposer: () => null }))

import type { AcquisitionKpis, AcquisitionRoster, QueueRow, QueueSnapshot } from "@/lib/my-leads/queries"
import type { MyLeadDripSnapshot } from "@/lib/my-leads/drip-queries"
import { MyLeadsClient, type MyLeadsFocus } from "./client"

const roster = {
  isOwner: true,
  members: [
    { id: "rep-1", label: "Maria", role: "owner", acquisitionsEnabled: true, active: true, hasHistory: true },
    { id: "rep-2", label: "Sam", role: "member", acquisitionsEnabled: true, active: true, hasHistory: true },
  ],
  settings: { enabled: true, recipientId: null, revision: 1 },
} as unknown as AcquisitionRoster
const kpis = { attempts: 1, reached: 1, offersSent: 0, contactWithoutFollowUp: 0, needsOffers: 0, appointmentsOverdue: 0, lastAttemptAt: null, asOf: "2026-09-11T14:00:00Z", missingRecordings: 0, recordingExpectationUnknown: 0, averageTalkSeconds: 0, talkTimeSamples: 0, talkTimeUnknown: 0, conversationsOverFiveMinutes: 0, pendingOutcomes: 0, firstCallSamples: 0, firstCallPending: 0, firstCallElapsedSeconds: 0, appointmentsDue: 0, appointmentsHeld: 0, orgAppointmentsUnattributed: 0, staleLeads: 0 } as unknown as AcquisitionKpis

const row = (propertyId: string, address: string, extra: Partial<QueueRow> = {}): QueueRow => ({
  propertyId, stage: "not_contacted", queueVersion: 1, sharedStatus: "new_lead", assignmentEpisodeId: `ep-${propertyId}`, assignedAt: "2026-09-11T14:00:00.000Z",
  initializedAt: "2026-09-11T14:00:00.000Z", episodeKind: "live", clockEligible: true, firstCallAt: null, stageEnteredAt: null, address, city: "Kansas City", state: "MO",
  homeownerName: `Owner of ${address}`, phone: "555-0100", contactId: "c", phones: ["555-0100"], contactDnc: false, temperature: null, motivationKind: null, motivationText: null,
  warningReasons: [], nextStepAt: null, nextStepType: null, offer: null, attemptsCount: 0, ...extra,
}) as QueueRow
const snap = (rows: QueueRow[], total = rows.length, at = "2026-09-11T14:00:00.000Z"): QueueSnapshot => ({
  stages: { not_contacted: { rows, totalCount: total, filteredCount: total, cursor: null, hasMore: false } }, snapshotAt: at, nextWarningAt: null, search: "",
}) as unknown as QueueSnapshot
const noDrips = (): MyLeadDripSnapshot => ({ active: [], replied: [], repliedCount: 0, counts: { not_contacted: 0, contacted: 0, needs_offer: 0, offer_sent: 0, under_contract: 0 } })
const dripOf = (r: QueueRow) => ({ propertyId: r.propertyId, enrollmentId: "e", enrollmentStatus: "active", sequenceId: "s", sequenceName: "Seller follow-up", step: 1, totalSteps: 3,
  nextTextAt: null, lastText: null, status: null, reason: null, stage: "not_contacted", repliedAt: null, queueRow: r }) as unknown as MyLeadDripSnapshot["active"][number]
const found = (r: QueueRow) => ({ ok: true, lookup: { status: "found", row: r, snapshotAt: "2026-09-11T14:00:00.000Z" } })
const unavailable = (reason: string) => ({ ok: true, lookup: { status: "unavailable", reason } })


const T0 = "2026-09-11T14:00:00.000Z"
const T5 = "2026-09-11T14:05:00.000Z"
async function saveContract(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.click(within(screen.getByTestId(`my-lead-actions-${id}`)).getByRole("button", { name: "Contract signed" }))
  await screen.findByRole("dialog")
  fireEvent.change(screen.getByLabelText("Signed at"), { target: { value: "2026-09-11T10:00" } })
  await user.click(screen.getByRole("button", { name: "Record contract" }))
  await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalled())
}

const loaded = row("loaded-1", "1 Loaded Lane")
const beyond = row("beyond-9", "9 Beyond Lane", { assignmentEpisodeId: "ep-b" })

function ui(focus: MyLeadsFocus | null, snapshot = snap([loaded], 25), drips: MyLeadDripSnapshot = noDrips()) {
  return <MyLeadsClient viewer={{ userId: "rep-1", orgId: "org-1", isOwner: true }} roster={roster} initialMemberId="rep-1" initialSnapshot={snapshot} initialKpis={kpis} initialDrips={drips} focus={focus} />
}
const focusOn = (r: QueueRow, memberId = "rep-1"): MyLeadsFocus => ({ propertyId: r.propertyId, memberId, notice: null, pin: r })
const leadEls = (id: string) => document.querySelectorAll(`[data-lead-id="${id}"]`)
const refreshNow = async () => { await act(async () => { window.dispatchEvent(new Event("focus")) }) }

describe("MyLeadsClient pinned deep-link row", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    for (const m of Object.values(mocks)) m.mockReset()
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: snap([loaded], 25), kpis, drips: noDrips() })
    mocks.loadMyLeadDetail.mockResolvedValue({ ok: false, message: "no detail" })
    // Database truth for the two fixture leads; tests override per scenario.
    mocks.loadMyLeadRow.mockImplementation(async ({ propertyId }: { propertyId: string }) =>
      propertyId === "beyond-9" ? found(beyond) : propertyId === "loaded-1" ? found(loaded) : unavailable("not_found"))
  })

  it("shows a lead that is on a loaded page in place, expanded, with no pin", () => {
    render(ui(focusOn(loaded)))
    expect(leadEls("loaded-1")).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Hide details for 1 Loaded Lane" })).toBeInTheDocument()
    expect(screen.getAllByText("Opened from lead page")).toHaveLength(1)
  })

  it("pins a lead from beyond the loaded pages at the top of its section, tagged, expanded, counts untouched", () => {
    render(ui(focusOn(beyond)))
    const section = screen.getByTestId("my-leads-section-not_contacted")
    const rows = section.querySelectorAll("[data-lead-id]")
    expect(rows[0]).toHaveAttribute("data-lead-id", "beyond-9")
    expect(rows).toHaveLength(2)
    expect(within(section).getByText("Opened from lead page")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Hide details for 9 Beyond Lane" })).toBeInTheDocument()
    expect(within(section).getByLabelText("25 leads")).toBeInTheDocument()
    expect(within(section).getByText("Showing 1 of 25")).toBeInTheDocument()
  })

  it("shows an active-drip lead once, in the drip section, with no second pin", () => {
    const dripRow = row("drip-3", "3 Drip Lane")
    const drips = { ...noDrips(), active: [dripOf(dripRow)] }
    render(ui(focusOn(dripRow), snap([loaded], 25), drips))
    expect(leadEls("drip-3")).toHaveLength(1)
    expect(screen.getByTestId("my-leads-section-in_drip").querySelector('[data-lead-id="drip-3"]')).not.toBeNull()
    expect(screen.getAllByText("Opened from lead page")).toHaveLength(1)
  })

  it("does not duplicate a pinned lead that is also the replied-drip pin", () => {
    const replied = { ...dripOf(beyond), status: "Replied" as never, repliedAt: "2026-09-11T13:00:00Z" }
    const drips = { ...noDrips(), replied: [replied], repliedCount: 1 }
    render(ui(focusOn(beyond), snap([loaded], 25), drips))
    expect(leadEls("beyond-9")).toHaveLength(1)
  })

  it("drops the pin and explains why when a refresh makes the lead unavailable (reassignment mid-session)", async () => {
    render(ui(focusOn(beyond)))
    mocks.loadMyLeadRow.mockResolvedValue(unavailable("other_rep"))
    await refreshNow()
    await waitFor(() => expect(leadEls("beyond-9")).toHaveLength(0))
    expect(screen.getByRole("status")).toHaveTextContent("This lead is assigned to another rep.")
  })

  it("moves a pinned lead into the drip section when it enters a drip, without showing it twice", async () => {
    render(ui(focusOn(beyond)))
    expect(screen.getByTestId("my-leads-section-not_contacted").querySelector('[data-lead-id="beyond-9"]')).not.toBeNull()
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: snap([loaded], 25), kpis, drips: { ...noDrips(), active: [dripOf(beyond)] } })
    await refreshNow()
    await waitFor(() => expect(screen.getByTestId("my-leads-section-in_drip").querySelector('[data-lead-id="beyond-9"]')).not.toBeNull())
    expect(leadEls("beyond-9")).toHaveLength(1)
  })

  it("re-reads the pin on every refresh path and keeps counts unchanged", async () => {
    render(ui(focusOn(beyond)))
    await refreshNow()
    await refreshNow()
    await waitFor(() => expect(mocks.loadMyLeadRow).toHaveBeenCalledTimes(2))
    expect(mocks.loadMyLeadRow).toHaveBeenCalledWith({ memberId: "rep-1", propertyId: "beyond-9" })
    expect(screen.getByLabelText("25 leads")).toBeInTheDocument()
  })

  it("ignores a late pin response from a superseded refresh", async () => {
    render(ui(focusOn(beyond)))
    let late!: (value: unknown) => void
    mocks.loadMyLeadRow.mockImplementationOnce(() => new Promise((resolve) => { late = resolve }))
    await refreshNow() // refresh #1, pin pending
    mocks.loadMyLeadRow.mockResolvedValueOnce(found({ ...beyond, queueVersion: 4 }))
    await refreshNow() // refresh #2 resolves first
    await act(async () => { late(unavailable("archived")) })
    expect(leadEls("beyond-9")).toHaveLength(1)
    expect(screen.queryByText("This lead was archived from My Leads.")).toBeNull()
  })

  it("keeps the pin when a pin read fails transiently", async () => {
    render(ui(focusOn(beyond)))
    mocks.loadMyLeadRow.mockResolvedValue({ ok: false, code: "READ_FAILED", message: "x" })
    await refreshNow()
    expect(leadEls("beyond-9")).toHaveLength(1)
  })

  it("drops the pin when the user changes the search", async () => {
    render(ui(focusOn(beyond)))
    fireEvent.change(screen.getByLabelText("Search My Leads"), { target: { value: "x" } })
    expect(leadEls("beyond-9")).toHaveLength(0)
    expect(mocks.replace).toHaveBeenCalledWith("/my-leads", { scroll: false })
  })

  it("loads an owner deep link on the assignee's queue with the assignee's pin lookup", async () => {
    const { rerender } = render(ui(null))
    rerender(ui(focusOn(beyond, "rep-2")))
    await waitFor(() => expect(mocks.loadMyLeads).toHaveBeenCalledWith(expect.objectContaining({ memberId: "rep-2" })))
    await waitFor(() => expect(mocks.loadMyLeadRow).toHaveBeenCalledWith({ memberId: "rep-2", propertyId: "beyond-9" }))
  })

  it("saves on a pinned row with the refreshed version and never hits a stale state", async () => {
    const user = userEvent.setup()
    mocks.submitMyLeadCommand.mockResolvedValue({ ok: true })
    render(ui(focusOn(beyond)))
    // A background refresh brings a newer version of the same episode.
    mocks.loadMyLeadRow.mockResolvedValue(found({ ...beyond, queueVersion: 3, sharedStatus: "interested" }))
    await refreshNow()
    await waitFor(() => expect(mocks.loadMyLeadRow).toHaveBeenCalledTimes(1))
    const actions = screen.getByTestId("my-lead-actions-beyond-9")
    await user.click(within(actions).getByRole("button", { name: "Contract signed" }))
    await screen.findByRole("dialog")
    fireEvent.change(screen.getByLabelText("Signed at"), { target: { value: "2026-09-11T10:00" } })
    await user.click(screen.getByRole("button", { name: "Record contract" }))
    await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalled())
    expect(mocks.submitMyLeadCommand.mock.calls[0][1]).toMatchObject({ propertyId: "beyond-9", expectedEpisodeId: "ep-b", expectedQueueVersion: 3, expectedSharedStatus: "interested" })
  })

  it("removes an unavailable lead from every rendered section, leaving server counts alone", async () => {
    const dripRow = row("drip-3", "3 Drip Lane")
    const { rerender } = render(ui(focusOn(loaded), snap([loaded], 25), { ...noDrips(), active: [dripOf(dripRow)] }))
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: snap([loaded], 25), kpis, drips: { ...noDrips(), active: [dripOf(dripRow)] } })
    mocks.loadMyLeadRow.mockResolvedValue(unavailable("other_rep"))
    await refreshNow()
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("assigned to another rep"))
    expect(leadEls("loaded-1")).toHaveLength(0)
    expect(screen.getByLabelText("25 leads")).toBeInTheDocument()
    rerender(ui(focusOn(dripRow), snap([loaded], 25), { ...noDrips(), active: [dripOf(dripRow)] }))
    mocks.loadMyLeadRow.mockResolvedValue(unavailable("archived"))
    await refreshNow()
    await waitFor(() => expect(leadEls("drip-3")).toHaveLength(0))
  })

  it("replaces a stale loaded copy in place when the lookup is newer in the same section", async () => {
    const other = row("loaded-2", "2 Other Lane")
    render(ui(focusOn(loaded), snap([loaded, other], 25)))
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: snap([loaded, other], 25), kpis, drips: noDrips() })
    mocks.loadMyLeadRow.mockResolvedValue(found({ ...loaded, queueVersion: 4, address: "1 Loaded Lane Updated" }))
    await refreshNow()
    await screen.findByRole("button", { name: /details for 1 Loaded Lane Updated/ })
    expect(leadEls("loaded-1")).toHaveLength(1)
    const ids = [...screen.getByTestId("my-leads-section-not_contacted").querySelectorAll("[data-lead-id]")].map((el) => el.getAttribute("data-lead-id"))
    expect(ids).toEqual(["loaded-1", "loaded-2"])
    expect(screen.getByLabelText("25 leads")).toBeInTheDocument()
  })

  it("moves a lead to its new section when the lookup shows a later stage or episode, with one rendered row", async () => {
    render(ui(focusOn(loaded)))
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: snap([loaded], 25), kpis, drips: noDrips() })
    mocks.loadMyLeadRow.mockResolvedValue(found({ ...loaded, stage: "contacted", queueVersion: 2 }))
    await refreshNow()
    await waitFor(() => expect(screen.getByTestId("my-leads-section-contacted").querySelector('[data-lead-id="loaded-1"]')).not.toBeNull())
    expect(screen.getByTestId("my-leads-section-not_contacted").querySelector('[data-lead-id="loaded-1"]')).toBeNull()
    expect(leadEls("loaded-1")).toHaveLength(1)
    expect(screen.getByLabelText("25 leads")).toBeInTheDocument()
    mocks.loadMyLeadRow.mockResolvedValue(found({ ...loaded, assignmentEpisodeId: "ep-new", assignedAt: "2026-09-12T00:00:00.000Z", queueVersion: 1 }))
    await refreshNow()
    await waitFor(() => expect(screen.getByTestId("my-leads-section-not_contacted").querySelector('[data-lead-id="loaded-1"]')).not.toBeNull())
    expect(leadEls("loaded-1")).toHaveLength(1)
  })

  it("recovers a STALE_STATE save on a loaded, non-pinned lead from the authoritative lookup", async () => {
    const user = userEvent.setup()
    mocks.submitMyLeadCommand
      .mockResolvedValueOnce({ ok: false, certainty: "rejected", code: "STALE_STATE", message: "This lead changed." })
      .mockResolvedValueOnce({ ok: true })
    render(ui(null))
    await user.click(screen.getByRole("button", { name: "Show details for 1 Loaded Lane" }))
    const actions = screen.getByTestId("my-lead-actions-loaded-1")
    await user.click(within(actions).getByRole("button", { name: "Contract signed" }))
    await screen.findByRole("dialog")
    fireEvent.change(screen.getByLabelText("Signed at"), { target: { value: "2026-09-11T10:00" } })
    await user.click(screen.getByRole("button", { name: "Record contract" }))
    // The list read still carries the stale row; only the single-row lookup is fresh.
    mocks.loadMyLeadRow.mockResolvedValue(found({ ...loaded, queueVersion: 7, sharedStatus: "interested" }))
    await user.click(await screen.findByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(mocks.loadMyLeadRow).toHaveBeenCalledWith({ memberId: "rep-1", propertyId: "loaded-1" }))
    await user.click(await screen.findByRole("button", { name: "Record contract" }))
    await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2))
    expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toMatchObject({ expectedQueueVersion: 7, expectedSharedStatus: "interested", expectedEpisodeId: "ep-loaded-1" })
  })

  it("removes an unavailable lead from an active drip entry that has no queue row", async () => {
    const bare = { ...dripOf(row("drip-4", "4 Bare Lane")), queueRow: null } as MyLeadDripSnapshot["active"][number]
    const drips = { ...noDrips(), active: [bare] }
    render(ui(focusOn(row("drip-4", "4 Bare Lane")), snap([loaded], 25), drips))
    expect(leadEls("drip-4")).toHaveLength(1)
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: snap([loaded], 25), kpis, drips })
    mocks.loadMyLeadRow.mockResolvedValue(unavailable("closed_dead_dnc"))
    await refreshNow()
    await waitFor(() => expect(leadEls("drip-4")).toHaveLength(0))
    expect(screen.getByRole("status")).toHaveTextContent("closed, dead or marked do-not-contact")
  })

  it("never resurrects an old pin over a list row when the lookup fails", async () => {
    const episodeA = { ...beyond, assignmentEpisodeId: "ep-A", address: "9 Episode A Lane" }
    const episodeB = { ...beyond, assignmentEpisodeId: "ep-B", assignedAt: "2026-09-12T00:00:00.000Z", address: "9 Episode B Lane" }
    render(ui(focusOn(episodeA)))
    // Collapse details so the refreshed list is rendered (open details retain the old list).
    await userEvent.setup().click(screen.getByRole("button", { name: /Hide details for 9 Episode A Lane/ }))
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: snap([episodeB, loaded], 25), kpis, drips: noDrips() })
    mocks.loadMyLeadRow.mockResolvedValue({ ok: false, code: "READ_FAILED", message: "x" })
    await refreshNow()
    await screen.findByRole("button", { name: /details for 9 Episode B Lane/ })
    expect(screen.queryByRole("button", { name: /details for 9 Episode A Lane/ })).toBeNull()
    expect(leadEls("beyond-9")).toHaveLength(1)
  })

  it("keeps the last good pin when the lookup fails and the list lacks the lead", async () => {
    render(ui(focusOn(beyond)))
    mocks.loadMyLeadRow.mockResolvedValue({ ok: false, code: "READ_FAILED", message: "x" })
    await refreshNow()
    expect(leadEls("beyond-9")).toHaveLength(1)
  })

  it("does not let an older lookup displace or reorder a newer list row", async () => {
    const newer = { ...loaded, queueVersion: 8, address: "1 Loaded Lane v8" }
    const other = row("loaded-2", "2 Other Lane")
    render(ui(focusOn(loaded), snap([newer, other], 25)))
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: snap([newer, other], 25), kpis, drips: noDrips() })
    mocks.loadMyLeadRow.mockResolvedValue(found({ ...loaded, queueVersion: 3, address: "1 Loaded Lane v3" }))
    await refreshNow()
    await waitFor(() => expect(mocks.loadMyLeadRow).toHaveBeenCalled())
    expect(screen.getByRole("button", { name: /details for 1 Loaded Lane v8/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /v3/ })).toBeNull()
    expect([...screen.getByTestId("my-leads-section-not_contacted").querySelectorAll("[data-lead-id]")].map((el) => el.getAttribute("data-lead-id"))).toEqual(["loaded-1", "loaded-2"])
  })

  it("keeps recovery blocked with a retryable error when the authoritative lookup fails", async () => {
    const user = userEvent.setup()
    mocks.submitMyLeadCommand.mockResolvedValueOnce({ ok: false, certainty: "rejected", code: "STALE_STATE", message: "This lead changed." })
    render(ui(null))
    await user.click(screen.getByRole("button", { name: "Show details for 1 Loaded Lane" }))
    await user.click(within(screen.getByTestId("my-lead-actions-loaded-1")).getByRole("button", { name: "Contract signed" }))
    await screen.findByRole("dialog")
    fireEvent.change(screen.getByLabelText("Signed at"), { target: { value: "2026-09-11T10:00" } })
    await user.click(screen.getByRole("button", { name: "Record contract" }))
    mocks.loadMyLeadRow.mockResolvedValue({ ok: false, code: "READ_FAILED", message: "x" })
    await user.click(await screen.findByRole("button", { name: "Refresh" }))
    expect(await screen.findByText(/Could not refresh this lead/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Record contract" })).toBeDisabled()
    // Retrying with a working lookup unblocks it.
    mocks.loadMyLeadRow.mockResolvedValue(found({ ...loaded, queueVersion: 2 }))
    await user.click(screen.getByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Record contract" })).toBeEnabled())
  })

  it("renders a replied lead in its new section when a newer lookup changes its stage", async () => {
    const replied = { ...dripOf(beyond), status: "Replied" as never, repliedAt: "2026-09-11T13:00:00Z" }
    render(ui(focusOn(beyond), snap([loaded], 25), { ...noDrips(), replied: [replied], repliedCount: 1 }))
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: snap([loaded], 25), kpis, drips: { ...noDrips(), replied: [replied], repliedCount: 1 } })
    mocks.loadMyLeadRow.mockResolvedValue(found({ ...beyond, stage: "contacted", queueVersion: 2 }))
    await refreshNow()
    await waitFor(() => expect(screen.getByTestId("my-leads-section-contacted").querySelector('[data-lead-id="beyond-9"]')).not.toBeNull())
    expect(screen.getByTestId("my-leads-section-not_contacted").querySelector('[data-lead-id="beyond-9"]')).toBeNull()
    expect(leadEls("beyond-9")).toHaveLength(1)
  })

  it("renders one row in the right section when a newer replied-drip row meets a retained stage snapshot", async () => {
    const user = userEvent.setup()
    const other = row("loaded-2", "2 Other Lane")
    render(ui(null, snap([loaded, other], 25)))
    await user.click(screen.getByRole("button", { name: "Show details for 2 Other Lane" })) // open details retain the list
    const newer = { ...loaded, stage: "contacted" as const, queueVersion: 3 }
    const replied = { ...dripOf(newer), stage: "contacted" as const, status: "Replied" as never, repliedAt: "2026-09-11T13:00:00Z" }
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: snap([loaded, other], 25, "2026-09-11T14:05:00.000Z"), kpis, drips: { ...noDrips(), replied: [replied], repliedCount: 1 } })
    await refreshNow()
    await waitFor(() => expect(screen.getByTestId("my-leads-section-contacted").querySelector('[data-lead-id="loaded-1"]')).not.toBeNull())
    expect(screen.getByTestId("my-leads-section-not_contacted").querySelector('[data-lead-id="loaded-1"]')).toBeNull()
    expect(leadEls("loaded-1")).toHaveLength(1)
  })

  it("keeps reconciling other leads when the target is unavailable", async () => {
    const other = row("loaded-2", "2 Other Lane")
    render(ui(focusOn(beyond), snap([loaded, other], 25, T0)))
    const newer = { ...loaded, stage: "contacted" as const, queueVersion: 3 }
    const replied = { ...dripOf(newer), stage: "contacted" as const, status: "Replied" as never, repliedAt: "2026-09-11T13:00:00Z" }
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: snap([loaded, other], 25, T5), kpis, drips: { ...noDrips(), replied: [replied], repliedCount: 1 }, dripsReadAt: T5 })
    mocks.loadMyLeadRow.mockResolvedValue(unavailable("other_rep"))
    await refreshNow()
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("assigned to another rep"))
    expect(leadEls("beyond-9")).toHaveLength(0)
    expect(leadEls("loaded-1")).toHaveLength(1)
    expect(screen.getByTestId("my-leads-section-contacted").querySelector('[data-lead-id="loaded-1"]')).not.toBeNull()
  })

  describe("commands take their preconditions from the opening lookup, never a list copy", () => {
    beforeEach(() => { mocks.submitMyLeadCommand.mockResolvedValue({ ok: true }) })

    it("a stale list sharedStatus at an equal version: the opening lookup supplies the fresh one", async () => {
      const user = userEvent.setup()
      render(ui(null, snap([loaded], 25)))
      await user.click(screen.getByRole("button", { name: "Show details for 1 Loaded Lane" }))
      // queueVersion is unchanged but the property's status moved on; only the lookup knows.
      mocks.loadMyLeadRow.mockResolvedValue(found({ ...loaded, sharedStatus: "interested" }))
      await saveContract(user, "loaded-1")
      expect(mocks.loadMyLeadRow).toHaveBeenCalledWith({ memberId: "rep-1", propertyId: "loaded-1" })
      expect(mocks.submitMyLeadCommand.mock.calls[0][1]).toMatchObject({ expectedQueueVersion: 1, expectedSharedStatus: "interested", expectedEpisodeId: "ep-loaded-1" })
    })

    it("uses the lookup even when the list copy looks newer", async () => {
      const user = userEvent.setup()
      const listCopy = { ...loaded, queueVersion: 9, sharedStatus: "list-status" }
      render(ui(null, snap([listCopy], 25)))
      await user.click(screen.getByRole("button", { name: "Show details for 1 Loaded Lane" }))
      mocks.loadMyLeadRow.mockResolvedValue(found({ ...loaded, queueVersion: 9, sharedStatus: "interested" }))
      await saveContract(user, "loaded-1")
      expect(mocks.submitMyLeadCommand.mock.calls[0][1]).toMatchObject({ expectedSharedStatus: "interested" })
    })

    it("a lookup failure on opening blocks with a retry and sends no save", async () => {
      const user = userEvent.setup()
      render(ui(null, snap([loaded], 25)))
      await user.click(screen.getByRole("button", { name: "Show details for 1 Loaded Lane" }))
      mocks.loadMyLeadRow.mockResolvedValue({ ok: false, code: "READ_FAILED", message: "x" })
      await user.click(within(screen.getByTestId("my-lead-actions-loaded-1")).getByRole("button", { name: "Contract signed" }))
      expect(await screen.findByText("Could not load current lead details. Retry to continue.")).toBeInTheDocument()
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(mocks.submitMyLeadCommand).not.toHaveBeenCalled()
      mocks.loadMyLeadRow.mockResolvedValue(found({ ...loaded, sharedStatus: "interested" }))
      await user.click(screen.getByRole("button", { name: "Retry opening" }))
      expect(await screen.findByRole("dialog")).toBeInTheDocument()
      expect(mocks.submitMyLeadCommand).not.toHaveBeenCalled()
    })

    it("recovery after STALE_STATE retries with the lookup row and never the list", async () => {
      const user = userEvent.setup()
      mocks.submitMyLeadCommand.mockResolvedValueOnce({ ok: false, certainty: "rejected", code: "STALE_STATE", message: "This lead changed." }).mockResolvedValueOnce({ ok: true })
      mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: snap([loaded], 25), kpis, drips: noDrips() }) // the list stays stale
      render(ui(null, snap([loaded], 25)))
      await user.click(screen.getByRole("button", { name: "Show details for 1 Loaded Lane" }))
      await saveContract(user, "loaded-1")
      mocks.loadMyLeadRow.mockResolvedValue(found({ ...loaded, queueVersion: 7, sharedStatus: "interested" }))
      await user.click(await screen.findByRole("button", { name: "Refresh" }))
      await user.click(await screen.findByRole("button", { name: "Record contract" }))
      await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2))
      expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toMatchObject({ expectedQueueVersion: 7, expectedSharedStatus: "interested" })
    })
  })

  describe("a second tab's save never leaves a stuck Saving…", () => {
    async function openContract(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole("button", { name: "Show details for 1 Loaded Lane" }))
      await user.click(within(screen.getByTestId("my-lead-actions-loaded-1")).getByRole("button", { name: "Contract signed" }))
      await screen.findByRole("dialog")
      fireEvent.change(screen.getByLabelText("Signed at"), { target: { value: "2026-09-11T10:00" } })
    }

    it("a stale-state answer ends in the recovery UI within the test", async () => {
      const user = userEvent.setup()
      mocks.submitMyLeadCommand.mockResolvedValue({ ok: false, certainty: "rejected", code: "STALE_STATE", message: "This lead changed. Refresh before trying again." })
      render(ui(null, snap([loaded], 25)))
      await openContract(user)
      await user.click(screen.getByRole("button", { name: "Record contract" }))
      expect(await screen.findByRole("button", { name: "Refresh" })).toBeInTheDocument()
      expect(screen.queryByText("Saving…")).toBeNull()
    })

    it("a rejected server action ends in the reconcile state", async () => {
      const user = userEvent.setup()
      mocks.submitMyLeadCommand.mockRejectedValue(new Error("response lost"))
      render(ui(null, snap([loaded], 25)))
      await openContract(user)
      await user.click(screen.getByRole("button", { name: "Record contract" }))
      expect(await screen.findByText(/original request is preserved for reconciliation/)).toBeInTheDocument()
      expect(screen.queryByText("Saving…")).toBeNull()
    })

    it("timeout, then a stale replay, then Refresh: the next save sends the refreshed version and succeeds", async () => {
      const user = userEvent.setup({ delay: null })
      mocks.submitMyLeadCommand
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValueOnce({ ok: false, certainty: "rejected", code: "STALE_STATE", message: "This lead changed. Refresh before trying again." })
        .mockResolvedValueOnce({ ok: true })
      render(ui(null, snap([loaded], 25)))
      await openContract(user)
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        fireEvent.click(screen.getByRole("button", { name: "Record contract" }))
        await act(async () => { await vi.advanceTimersByTimeAsync(25_001) })
      } finally { vi.useRealTimers() }
      await user.click(await screen.findByRole("button", { name: "Reconcile saved change" })) // replay of the frozen request
      mocks.loadMyLeadRow.mockResolvedValue(found({ ...loaded, queueVersion: 2, sharedStatus: "interested" }))
      await user.click(await screen.findByRole("button", { name: "Refresh" }))
      await screen.findByText(/Lead refreshed/)
      await user.click(screen.getByRole("button", { name: "Record contract" }))
      await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(3))
      expect(mocks.submitMyLeadCommand.mock.calls.map((call) => (call[1] as { expectedQueueVersion: number }).expectedQueueVersion)).toEqual([1, 1, 2])
      expect(mocks.submitMyLeadCommand.mock.calls[2][1]).toMatchObject({ expectedSharedStatus: "interested" })
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    })

    it("IDEMPOTENCY_CONFLICT shows the already-saved copy and Refresh closes the dialog", async () => {
      const user = userEvent.setup()
      mocks.submitMyLeadCommand.mockResolvedValue({ ok: false, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "This was already saved. Refresh to see it." })
      render(ui(null, snap([loaded], 25)))
      await openContract(user)
      await user.click(screen.getByRole("button", { name: "Record contract" }))
      expect(await screen.findByText("This was already saved. Refresh to see it.")).toBeInTheDocument()
      mocks.loadMyLeads.mockClear()
      await user.click(await screen.findByRole("button", { name: "Refresh" }))
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
      // The host's committed path ran: its queue refresh barrier published a fresh read.
      await waitFor(() => expect(mocks.loadMyLeads).toHaveBeenCalled())
      expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1)
    })

    it("commit then timeout: an unknown replay failure keeps reconciliation and the next replay succeeds once", async () => {
      const user = userEvent.setup({ delay: null })
      mocks.submitMyLeadCommand
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValueOnce({ ok: false, certainty: "unknown", message: "The update could not be confirmed. Retry with the same form." })
        .mockResolvedValueOnce({ ok: true, duplicate: true })
      render(ui(null, snap([loaded], 25)))
      await openContract(user)
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        fireEvent.click(screen.getByRole("button", { name: "Record contract" }))
        await act(async () => { await vi.advanceTimersByTimeAsync(25_001) })
      } finally { vi.useRealTimers() }
      await user.click(await screen.findByRole("button", { name: "Reconcile saved change" }))
      await user.click(await screen.findByRole("button", { name: "Reconcile saved change" }))
      await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(3))
      const calls = mocks.submitMyLeadCommand.mock.calls.map((call) => call[1])
      expect(calls[2]).toEqual(calls[0])
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    })

    it("FORBIDDEN keeps reconciliation; Refresh only re-reads the row; the replay succeeds once", async () => {
      const user = userEvent.setup()
      mocks.submitMyLeadCommand
        .mockResolvedValueOnce({ ok: false, certainty: "unknown", code: "FORBIDDEN", message: "This lead is unavailable or you no longer have access." })
        .mockResolvedValueOnce({ ok: true, duplicate: true })
      render(ui(null, snap([loaded], 25)))
      await openContract(user)
      await user.click(screen.getByRole("button", { name: "Record contract" }))
      await user.click(await screen.findByRole("button", { name: "Refresh" }))
      await screen.findByText(/Lead refreshed/)
      await user.click(screen.getByRole("button", { name: "Reconcile saved change" }))
      await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2))
      expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toEqual(mocks.submitMyLeadCommand.mock.calls[0][1])
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    })

    it("a first save the server rejects as invalid is not frozen: a corrected save succeeds", async () => {
      const user = userEvent.setup()
      mocks.submitMyLeadCommand
        .mockResolvedValueOnce({ ok: false, answered: true, certainty: "unknown", message: "The update could not be saved. Check the fields and retry." })
        .mockResolvedValueOnce({ ok: true })
      render(ui(null, snap([loaded], 25)))
      await openContract(user)
      await user.click(screen.getByRole("button", { name: "Record contract" }))
      expect(await screen.findByText("The update could not be saved. Check the fields and retry.")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Reconcile saved change" })).toBeNull()
      fireEvent.change(screen.getByLabelText("Signed at"), { target: { value: "2026-09-11T09:00" } })
      await user.click(screen.getByRole("button", { name: "Record contract" }))
      await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    })

    it("a server action that never answers ends in the reconcile state after the save timeout", async () => {
      const user = userEvent.setup({ delay: null })
      mocks.submitMyLeadCommand.mockImplementation(() => new Promise(() => undefined))
      render(ui(null, snap([loaded], 25)))
      await openContract(user)
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        fireEvent.click(screen.getByRole("button", { name: "Record contract" }))
        await act(async () => { await Promise.resolve() })
        expect(screen.getByText("Saving…")).toBeInTheDocument()
        await act(async () => { await vi.advanceTimersByTimeAsync(25_001) })
      } finally { vi.useRealTimers() }
      expect(await screen.findByText(/original request is preserved for reconciliation/)).toBeInTheDocument()
      expect(screen.queryByText("Saving…")).toBeNull()
    })
  })
})

