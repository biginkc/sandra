import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"

const mocks = vi.hoisted(() => ({
  routerRefresh: vi.fn(),
  submitMyLeadCommand: vi.fn(),
  loadMyLeads: vi.fn(),
  loadMyLeadRow: vi.fn(),
  loadMyLeadCallReferences: vi.fn(),
  savePostCallExtras: vi.fn(),
  startDripForLeads: vi.fn(),
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
  submitMyLeadHandoffDrip: vi.fn(),
  savePostCallExtras: mocks.savePostCallExtras,
  changeAcquisitionDesignation: vi.fn(),
  changeAcquisitionSettings: vi.fn(),
}))
vi.mock("@/app/(dashboard)/sequences/actions", () => ({
  listDripChoices: vi.fn(async () => ({ ok: true, data: [{ id: "drip-1", name: "Seller follow-up", textCount: 4, days: 90, firstSend: "Today" }] })),
  startDripForLeads: mocks.startDripForLeads,
}))
vi.mock("./rep-sms-composer", () => ({ RepSmsComposer: () => null }))
vi.mock("./_components/dialpad-panel", () => ({ DialpadPanel: () => null }))
vi.mock("./_components/queue", () => ({
  MyLeadsQueue: ({ stages, onStageAction }: { stages: Record<string, { rows: never[] } | undefined>; onStageAction: (action: string, row: never) => void }) => {
    const row = stages.not_contacted?.rows[0]
    return <button onClick={() => row && onStageAction("log-attempt", row)}>Log attempt</button>
  },
}))

import type { AcquisitionKpis, AcquisitionRoster, QueueRow, QueueSnapshot } from "@/lib/my-leads/queries"
import { MyLeadsClient } from "./client"

const viewer = { userId: "rep-1", orgId: "org-1", isOwner: false }
const roster: AcquisitionRoster = {
  isOwner: false,
  members: [{ id: "rep-1", label: "Maria", role: "member", acquisitionsEnabled: true, active: true, hasHistory: true }],
  settings: { enabled: true, recipientId: null, revision: 1 },
}
const kpis = {
  contactWithoutFollowUp: 0, needsOffers: 0, appointmentsOverdue: 0, lastAttemptAt: null, asOf: "2026-09-11T14:00:00Z", missingRecordings: 0,
  recordingExpectationUnknown: 0, averageTalkSeconds: null, talkTimeSamples: 0, talkTimeUnknown: 0, conversationsOverFiveMinutes: 0, attempts: 0, reached: 0,
  pendingOutcomes: 0, firstCallSamples: 0, firstCallPending: 0, firstCallElapsedSeconds: null, appointmentsDue: 0, appointmentsHeld: 0,
  orgAppointmentsUnattributed: 0, offersSent: 0, staleLeads: 0,
} as AcquisitionKpis
const row = {
  propertyId: "property-1", stage: "not_contacted", queueVersion: 1, sharedStatus: "new_lead", assignmentEpisodeId: "episode-1",
  assignedAt: "2026-09-11T14:00:00.000Z", initializedAt: "2026-09-11T14:00:00.000Z", episodeKind: "live", clockEligible: true, firstCallAt: null,
  stageEnteredAt: null, address: "106 Fixture Lane", city: "Kansas City", state: "MO", homeownerName: "Fixture", phone: "555-0100", contactId: "contact-1",
  phones: ["555-0100"], contactDnc: false, temperature: null, motivationKind: null, motivationText: null, warningReasons: [], nextStepAt: null,
  nextStepType: null, offer: null, attemptsCount: 0,
} as QueueRow
const snapshot: QueueSnapshot = {
  stages: { not_contacted: { rows: [row], totalCount: 1, filteredCount: 1, cursor: null, hasMore: false } },
  snapshotAt: "2026-09-11T14:00:00.000Z", nextWarningAt: null, search: "",
}

function renderClient(postCallPrompt: boolean) {
  mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot, kpis })
  mocks.loadMyLeadRow.mockResolvedValue({ ok: true, lookup: { status: "found", row, snapshotAt: snapshot.snapshotAt } })
  return render(
    <MyLeadsClient viewer={viewer} roster={roster} initialMemberId={viewer.userId} initialSnapshot={snapshot} initialKpis={kpis} postCallPrompt={postCallPrompt} />,
  )
}

describe("MyLeadsClient attempt logging behind post_call_prompt", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.loadMyLeadCallReferences.mockResolvedValue({ ok: true, options: [] })
    mocks.submitMyLeadCommand.mockResolvedValue({ ok: true })
    mocks.savePostCallExtras.mockResolvedValue({ ok: true, note: "saved", nextStep: "created" })
    window.localStorage.clear()
  })

  it("flag off: the old Log an attempt dialog renders and never touches the extras", async () => {
    const user = userEvent.setup()
    renderClient(false)
    await user.click(screen.getByRole("button", { name: "Log attempt" }))
    expect(screen.getByRole("dialog", { name: /Log an attempt/i })).toBeVisible()
    expect(screen.queryByTestId("post-call-prompt")).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText("Source"), "manual")
    await user.selectOptions(screen.getByLabelText("External outcome"), "reached")
    fireEvent.change(screen.getByLabelText("When did the outreach occur?"), { target: { value: "2026-09-11T09:00" } })
    await user.click(screen.getByRole("button", { name: "Save attempt" }))
    await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1))
    const [, input] = mocks.submitMyLeadCommand.mock.calls[0]
    expect(input).toMatchObject({ source: "manual", kind: "outreach", outcome: "reached" })
    expect(input).not.toHaveProperty("postCall")
    expect(mocks.savePostCallExtras).not.toHaveBeenCalled()
  })

  it("flag on: the post-call prompt renders instead of the old dialog", async () => {
    const user = userEvent.setup()
    renderClient(true)
    await user.click(screen.getByRole("button", { name: "Log attempt" }))
    expect(screen.getByTestId("post-call-prompt")).toBeVisible()
    expect(screen.queryByRole("dialog", { name: /Log an attempt/i })).not.toBeInTheDocument()
  })

  it("saves a voicemail with a note and a quick pick: extras stay out of the command and run once", async () => {
    const user = userEvent.setup()
    renderClient(true)
    await user.click(screen.getByRole("button", { name: "Log attempt" }))
    await user.click(screen.getByTestId("post-call-outcome-voicemail"))
    await user.type(screen.getByTestId("post-call-note"), "Left a message")
    await user.click(screen.getByTestId("post-call-pick-3-days"))
    fireEvent.change(screen.getByLabelText("When did it occur?"), { target: { value: "2026-09-11T09:00" } })
    fireEvent.change(screen.getByLabelText(/Recording link/), { target: { value: "https://dialpad.example/r/1" } })
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1))
    const [command, input] = mocks.submitMyLeadCommand.mock.calls[0]
    expect(command).toBe("log-attempt")
    expect(input).toMatchObject({ outcome: "voicemail", note: null, source: "dialpad", kind: "call" })
    expect(input).not.toHaveProperty("postCall")
    expect(JSON.stringify(input)).not.toContain("Left a message")
    await waitFor(() => expect(mocks.savePostCallExtras).toHaveBeenCalledTimes(1))
    expect(mocks.savePostCallExtras).toHaveBeenCalledWith(expect.objectContaining({
      memberId: "rep-1", propertyId: "property-1", note: "Left a message",
      nextStep: expect.objectContaining({ pick: "three_days" }),
      submissionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }))
    expect(await screen.findByTestId("post-call-receipt")).toHaveTextContent(/Attempt saved · Note saved · Next step set for/)
    // The drip picker, the follow-on buttons and a disabled Send contract all show after save.
    expect(await screen.findByRole("button", { name: /Seller follow-up/ })).toBeVisible()
    expect(screen.getByTestId("post-call-ready-for-offer")).toBeEnabled()
    expect(screen.getByTestId("post-call-dead-nurture")).toBeEnabled()
    expect(screen.getByTestId("post-call-send-contract")).toBeDisabled()
  })

  it("shows a Retry for a failed extra and runs the extras again only on Retry", async () => {
    const user = userEvent.setup()
    mocks.savePostCallExtras.mockResolvedValueOnce({ ok: true, note: "failed", nextStep: "created", message: "Note not saved: nope" })
    renderClient(true)
    await user.click(screen.getByRole("button", { name: "Log attempt" }))
    await user.click(screen.getByTestId("post-call-outcome-reached"))
    await user.type(screen.getByTestId("post-call-note"), "hello")
    fireEvent.change(screen.getByLabelText("When did it occur?"), { target: { value: "2026-09-11T09:00" } })
    fireEvent.change(screen.getByLabelText(/Recording link/), { target: { value: "https://dialpad.example/r/1" } })
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByTestId("post-call-retry-extras")).toBeVisible()
    expect(mocks.savePostCallExtras).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId("post-call-retry-extras"))
    await waitFor(() => expect(mocks.savePostCallExtras).toHaveBeenCalledTimes(2))
    expect(mocks.savePostCallExtras.mock.calls[1][0].submissionId).toBe(mocks.savePostCallExtras.mock.calls[0][0].submissionId)
    expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByTestId("post-call-retry-extras")).not.toBeInTheDocument())
  })
})
