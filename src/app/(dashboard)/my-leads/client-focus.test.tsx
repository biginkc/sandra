import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  loadMyLeads: vi.fn(),
  queueProps: [] as Array<Record<string, unknown>>,
}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }) }))
vi.mock("@/components/softphone/softphone-provider", () => ({ useOptionalSoftphone: () => null }))
vi.mock("@/components/appointments/book-appointment-popover", () => ({ BookAppointmentPopover: () => null }))
vi.mock("./actions", () => ({
  loadMyLeads: mocks.loadMyLeads, loadMyLeadsStage: vi.fn(), loadMyLeadDetail: vi.fn(), loadMyLeadCallReferences: vi.fn(async () => ({ ok: true, options: [] })),
  submitMyLeadCommand: vi.fn(), submitMyLeadHandoffDrip: vi.fn(), changeAcquisitionDesignation: vi.fn(), changeAcquisitionSettings: vi.fn(),
}))
vi.mock("./rep-sms-settings", () => ({ RepSmsSettings: () => null }))
vi.mock("./_components/queue", () => ({
  MyLeadsQueue: (props: Record<string, unknown> & { search: string; selectedRepId: string; onSearchChange: (v: string) => void; onRepChange: (v: string) => void }) => {
    mocks.queueProps.push(props)
    return <section>
      <input aria-label="Search My Leads" value={props.search} onChange={(e) => props.onSearchChange(e.target.value)} />
      <select aria-label="Rep" value={props.selectedRepId} onChange={(e) => props.onRepChange(e.target.value)}>
        <option value="rep-1">Maria</option><option value="rep-2">Sam</option>
      </select>
    </section>
  },
}))

import type { AcquisitionKpis, AcquisitionRoster, QueueSnapshot } from "@/lib/my-leads/queries"
import { MyLeadsClient, type MyLeadsFocus } from "./client"

const roster = {
  isOwner: true,
  members: [
    { id: "rep-1", label: "Maria", role: "owner", acquisitionsEnabled: true, active: true, hasHistory: true },
    { id: "rep-2", label: "Sam", role: "member", acquisitionsEnabled: true, active: true, hasHistory: true },
  ],
  settings: { enabled: true, recipientId: null, revision: 1 },
} as unknown as AcquisitionRoster
const kpis = { attempts: 0, reached: 0, offersSent: 0, contactWithoutFollowUp: 0, needsOffers: 0, appointmentsOverdue: 0, lastAttemptAt: null, asOf: "2026-09-11T14:00:00Z", missingRecordings: 0, recordingExpectationUnknown: 0, averageTalkSeconds: 0, talkTimeSamples: 0, talkTimeUnknown: 0, conversationsOverFiveMinutes: 0, pendingOutcomes: 0, firstCallSamples: 0, firstCallPending: 0, firstCallElapsedSeconds: 0, appointmentsDue: 0, appointmentsHeld: 0, orgAppointmentsUnattributed: 0, staleLeads: 0, firstCallOverdue: 0 } as unknown as AcquisitionKpis
const snapshot = { stages: {}, snapshotAt: "2026-09-11T14:00:00.000Z", nextWarningAt: null, search: "" } as unknown as QueueSnapshot

const focus = (propertyId: string | null, extra: Partial<MyLeadsFocus> = {}): MyLeadsFocus => ({ propertyId, memberId: "rep-1", notice: null, ...extra })
function ui(f: MyLeadsFocus | null) {
  return <MyLeadsClient viewer={{ userId: "rep-1", orgId: "org-1", isOwner: true }} roster={roster} initialMemberId="rep-1" initialSnapshot={snapshot} initialKpis={kpis} focus={f} />
}
const last = () => mocks.queueProps[mocks.queueProps.length - 1]

describe("MyLeadsClient deep-link lifecycle", () => {
  beforeEach(() => {
    mocks.replace.mockReset(); mocks.refresh.mockReset(); mocks.queueProps.length = 0
    mocks.loadMyLeads.mockReset()
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot, kpis, drips: null })
  })

  it("seeds the target from the URL and keeps it through a plain server refresh", () => {
    const { rerender } = render(ui(focus("lead-a")))
    expect(last()).toMatchObject({ focusPropertyId: "lead-a", focusNonce: 0, search: "" })
    rerender(ui(focus("lead-a")))
    rerender(ui(focus("lead-a")))
    expect(last()).toMatchObject({ focusPropertyId: "lead-a", focusNonce: 0 })
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("clears the target and the URL once when the search changes", () => {
    render(ui(focus("lead-a")))
    const input = screen.getByLabelText("Search My Leads")
    fireEvent.change(input, { target: { value: "o" } })
    fireEvent.change(input, { target: { value: "oa" } })
    expect(last()).toMatchObject({ focusPropertyId: null, search: "oa" })
    expect(mocks.replace).toHaveBeenCalledTimes(1)
    expect(mocks.replace).toHaveBeenCalledWith("/my-leads", { scroll: false })
  })

  it("clears the target and the URL when the rep changes, and never touches the URL without a deep link", () => {
    const { unmount } = render(ui(focus("lead-a")))
    fireEvent.change(screen.getByLabelText("Rep"), { target: { value: "rep-2" } })
    expect(last()).toMatchObject({ focusPropertyId: null, selectedRepId: "rep-2" })
    expect(mocks.replace).toHaveBeenCalledTimes(1)
    unmount()
    mocks.replace.mockReset()
    render(ui(null))
    fireEvent.change(screen.getByLabelText("Search My Leads"), { target: { value: "x" } })
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("treats a new ?lead value as a new target, including Back/Forward and repeated links", () => {
    const { rerender } = render(ui(focus("lead-a")))
    rerender(ui(focus("lead-b")))
    expect(last()).toMatchObject({ focusPropertyId: "lead-b", focusNonce: 1 })
    rerender(ui(focus("lead-a"))) // Back
    expect(last()).toMatchObject({ focusPropertyId: "lead-a", focusNonce: 2 })
    // URL cleared after a filter change, then the same lead is linked again.
    fireEvent.change(screen.getByLabelText("Search My Leads"), { target: { value: "z" } })
    rerender(ui(null))
    expect(last()).toMatchObject({ focusPropertyId: null })
    rerender(ui(focus("lead-a")))
    expect(last()).toMatchObject({ focusPropertyId: "lead-a" })
    expect(last()?.focusNonce).toBeGreaterThan(2)
    // After a new target clears again the URL can be cleared again.
    fireEvent.change(screen.getByLabelText("Search My Leads"), { target: { value: "zz" } })
    expect(mocks.replace).toHaveBeenCalledTimes(2)
  })

  it("opens a new deep link unfiltered and on the lead's rep queue", async () => {
    const { rerender } = render(ui(null))
    fireEvent.change(screen.getByLabelText("Search My Leads"), { target: { value: "oak" } })
    expect(last()).toMatchObject({ search: "oak" })
    rerender(ui(focus("lead-c", { memberId: "rep-2" })))
    await waitFor(() => expect(last()).toMatchObject({ focusPropertyId: "lead-c", selectedRepId: "rep-2", search: "" }))
  })

  it("shows a not-in-queue notice until the user changes the view", () => {
    render(ui(focus(null, { notice: "That lead is assigned to another rep." })))
    expect(screen.getByRole("status")).toHaveTextContent("assigned to another rep")
    fireEvent.change(screen.getByLabelText("Search My Leads"), { target: { value: "x" } })
    expect(screen.queryByText(/assigned to another rep/)).toBeNull()
    expect(mocks.replace).toHaveBeenCalledTimes(1)
  })

  it("follows the same lead when a refresh reassigns it, without re-scrolling an unchanged refresh", async () => {
    const { rerender } = render(ui(focus("lead-a", { memberId: "rep-1" })))
    rerender(ui(focus("lead-a", { memberId: "rep-1" })))
    expect(last()).toMatchObject({ focusNonce: 0, selectedRepId: "rep-1" })
    rerender(ui(focus("lead-a", { memberId: "rep-2" })))
    await waitFor(() => expect(last()).toMatchObject({ focusPropertyId: "lead-a", selectedRepId: "rep-2", search: "" }))
    expect(last()?.focusNonce).toBe(1)
  })
})

