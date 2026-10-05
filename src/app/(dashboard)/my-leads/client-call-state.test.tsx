import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"

import type { CallNextSnapshot } from "@/lib/my-leads/call-next"
import type { CallbackDueItem, CallPromptItem, CallStateSnapshot } from "@/lib/my-leads/call-state"
import type { AcquisitionKpis, AcquisitionRoster, QueueSnapshot } from "@/lib/my-leads/queries"
import { queueRowFixture, stripItem } from "./_components/call-next-test-support"

const mocks = vi.hoisted(() => ({
  routerRefresh: vi.fn(),
  loadMyLeads: vi.fn(),
  loadMyLeadRow: vi.fn(),
  loadMyLeadCallReferences: vi.fn(),
  submitMyLeadCommand: vi.fn(),
  savePostCallExtras: vi.fn(),
  dialLead: vi.fn(),
  poll: vi.fn(),
  ack: vi.fn(),
  status: vi.fn(),
  softphone: null as null | { callingEnabled: boolean; openLead: (lead: unknown) => void },
}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.routerRefresh }) }))
vi.mock("@/components/softphone/softphone-provider", () => ({ useOptionalSoftphone: () => mocks.softphone }))
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
  listDripChoices: vi.fn(async () => ({ ok: true, data: [] })),
  startDripForLeads: vi.fn(),
}))
vi.mock("./dialpad-actions", () => ({
  dialLeadAction: mocks.dialLead,
  getDialpadCallStatusAction: (...a: unknown[]) => mocks.status(...a),
  cancelDialpadCallAction: vi.fn(),
  ensureDialpadBindingAction: vi.fn(),
}))
vi.mock("./call-state-actions", () => ({
  pollMyLeadsCallStateAction: mocks.poll,
  acknowledgeCallPromptAction: mocks.ack,
}))
vi.mock("./strip-actions", () => ({ setStripOverride: vi.fn(), loadTriage: vi.fn(), loadCallNext: vi.fn() }))
vi.mock("./rep-sms-composer", () => ({ RepSmsComposer: () => null }))
vi.mock("./_components/queue", () => ({
  MyLeadsQueue: ({
    stages,
    onStageAction,
  }: {
    stages: Record<string, { rows: { propertyId: string; stripReason?: string }[] } | undefined>
    onStageAction: (action: string, row: never) => void
  }) => (
    <section aria-label="Mock My Leads queue">
      {Object.values(stages).flatMap((page) => page?.rows ?? []).map((row) => (
        <div key={row.propertyId}>
          <button onClick={() => onStageAction("log-attempt", row as never)}>{`Log attempt ${row.propertyId}`}</button>
          <button onClick={() => onStageAction("start-call", row as never)}>{`Start call ${row.propertyId}`}</button>
        </div>
      ))}
    </section>
  ),
}))

import { MyLeadsClient } from "./client"
import { EMPTY_CALL_STATE } from "@/lib/my-leads/call-state"
import { resetExtrasStoreForTests } from "./_components/extras-store"

type Props = React.ComponentProps<typeof MyLeadsClient>
type FlagProps = NonNullable<Props["callFeatures"]>

const SNAPSHOT_AT = "2026-10-05T15:00:00Z"
const viewer = { userId: "rep-1", orgId: "org-1", isOwner: false }
const roster: AcquisitionRoster = {
  isOwner: false,
  members: [{ id: "rep-1", label: "Maria", role: "member", acquisitionsEnabled: true, active: true, hasHistory: true }],
  settings: { enabled: true, recipientId: "owner-1", revision: 1 },
}
const kpis = {
  contactWithoutFollowUp: 0, needsOffers: 0, appointmentsOverdue: 0, lastAttemptAt: null, asOf: "2026-10-05T14:00:00Z", missingRecordings: 0,
  recordingExpectationUnknown: 0, averageTalkSeconds: null, talkTimeSamples: 0, talkTimeUnknown: 0, conversationsOverFiveMinutes: 0, attempts: 0,
  reached: 0, pendingOutcomes: 0, firstCallSamples: 0, firstCallPending: 0, firstCallElapsedSeconds: null, appointmentsDue: 0, appointmentsHeld: 0,
  orgAppointmentsUnattributed: 0, offersSent: 0, staleLeads: 0,
} as AcquisitionKpis
const rows = [
  queueRowFixture("property-1", { stage: "not_contacted", address: "1 First Lane", contactId: "contact-1" }),
  queueRowFixture("property-2", { stage: "not_contacted", address: "2 Second Lane", contactId: "contact-2" }),
]
const snapshot = (): QueueSnapshot => ({
  stages: { not_contacted: { rows, totalCount: 2, filteredCount: 2, cursor: null, hasMore: false } },
  snapshotAt: SNAPSHOT_AT, nextWarningAt: null, search: "",
})
const strip = (): CallNextSnapshot => ({
  rows: [stripItem("property-1", "inbound_text"), stripItem("property-2", "appointment_overdue")],
  excluded: [], hiddenCount: 0, snapshotAt: SNAPSHOT_AT,
})
const dialpad = { connectionId: "c1", binding: { status: "verified", dialpadUserId: "5551234" }, grants: [] } as unknown as NonNullable<Props["dialpad"]>
const flags = (over: Partial<FlagProps> = {}): FlagProps => ({ clickToDial: false, autoPrompt: false, callbackAlert: false, ...over })

const prompt = (over: Partial<CallPromptItem> = {}): CallPromptItem => ({
  attemptId: "attempt-old", propertyId: "property-1", callActivityId: "activity-old", endedAt: "2026-10-05T10:00:00Z",
  durationSeconds: 60, talkDurationSeconds: 30, origin: "sandra", outcomeGuess: "voicemail", voicemail: true, ...over,
})
const due = (over: Partial<CallbackDueItem> = {}): CallbackDueItem => ({
  taskId: "task-1", propertyId: "property-2", dueAt: "2026-10-05T14:55:00Z", title: "Callback", minutesLate: 5, ...over,
})
const pollState = (over: Partial<CallStateSnapshot> = {}) => ({
  ok: true as const,
  state: { ...EMPTY_CALL_STATE, features: { autoPrompt: true, callbackAlert: true }, ...over },
})
const dialOk = { ok: true, intentId: "intent-1", state: "awaiting_provider", uncertain: false, phoneSlot: 1 }

function renderClient(props: Partial<Props> = {}) {
  return render(
    <MyLeadsClient
      viewer={viewer}
      roster={roster}
      initialMemberId={viewer.userId}
      initialSnapshot={snapshot()}
      initialKpis={kpis}
      {...props}
    />,
  )
}
const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el)
  })
  await flush()
}
const callStatus = (intentId: string, state: string) => ({
  ok: true,
  status: {
    intentId, state, connected: state === "ended", propertyId: "property-1", expiresAt: "x", dispatchAuthorizedAt: null, failedAt: null,
    callActivityId: null, attemptId: null, startedAt: null, endedAt: null, durationSeconds: null, talkDurationSeconds: null, recordingCaptureId: null,
  },
})
const ackCalls = () => mocks.ack.mock.calls

beforeEach(() => {
  vi.useFakeTimers()
  for (const mock of Object.values(mocks)) if (typeof mock === "function" && "mockReset" in mock) mock.mockReset()
  mocks.softphone = null
  mocks.loadMyLeads.mockImplementation(async () => ({
    ok: true, snapshot: snapshot(), kpis, drips: { active: [], replied: [], repliedCount: 0, counts: {} }, strip: strip(),
  }))
  mocks.loadMyLeadRow.mockImplementation(async ({ propertyId }: { propertyId: string }) => ({
    ok: true, lookup: { status: "found", row: rows.find((r) => r.propertyId === propertyId) ?? rows[0], snapshotAt: SNAPSHOT_AT },
  }))
  mocks.loadMyLeadCallReferences.mockResolvedValue({ ok: true, options: [] })
  mocks.submitMyLeadCommand.mockResolvedValue({ ok: true })
  mocks.savePostCallExtras.mockResolvedValue({ ok: true, note: "saved", nextStep: "created" })
  mocks.poll.mockResolvedValue(pollState())
  mocks.ack.mockResolvedValue({ ok: true, status: "acknowledged" })
  mocks.status.mockResolvedValue({ ok: false, code: "not_configured", message: "" })
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetExtrasStoreForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("MyLeadsClient calling and durable call state", () => {
  it("falls back to the Sandra softphone when Dialpad is not connected", async () => {
    const openLead = vi.fn()
    mocks.softphone = { callingEnabled: true, openLead }
    renderClient({ dialpad: null })
    await click(screen.getByRole("button", { name: "Start call property-1" }))
    expect(openLead).toHaveBeenCalledTimes(1)
    expect(openLead).toHaveBeenCalledWith(expect.objectContaining({ id: "property-1", contactId: "contact-1" }))
    expect(mocks.dialLead).not.toHaveBeenCalled()
  })

  it("will not dial with Dialpad from another rep's queue", async () => {
    const ownerRoster: AcquisitionRoster = {
      ...roster,
      isOwner: true,
      members: [...roster.members, { ...roster.members[0], id: "rep-2", label: "Other rep" }],
    }
    renderClient({ viewer: { ...viewer, isOwner: true }, roster: ownerRoster, initialMemberId: "rep-2", dialpad })
    await click(screen.getByRole("button", { name: "Start call property-1" }))
    expect(screen.getByText("Open your own queue to call with Dialpad.")).toBeInTheDocument()
    expect(mocks.dialLead).not.toHaveBeenCalled()
  })

  describe("API dial outcomes", () => {
    it("shows the dial status after an accepted dial", async () => {
      mocks.dialLead.mockResolvedValue(dialOk)
      renderClient({ dialpad })
      await click(screen.getByRole("button", { name: "Start call property-1" }))
      expect(mocks.dialLead).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId("dial-status")).toBeInTheDocument()
    })

    it("counts down on a rate limit, then retries once with a fresh idempotency key", async () => {
      mocks.dialLead.mockResolvedValueOnce({ ok: false, code: "rate_limited", message: "Slow down", retryAfterSeconds: 2, freshAttemptKey: true })
      mocks.dialLead.mockResolvedValueOnce(dialOk)
      renderClient({ dialpad })
      await click(screen.getByRole("button", { name: "Start call property-1" }))
      expect(mocks.dialLead).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId("dial-status")).toHaveTextContent(/Retrying in 2s/)
      await flush(1000)
      expect(screen.getByTestId("dial-status")).toHaveTextContent(/Retrying in 1s/)
      expect(mocks.dialLead).toHaveBeenCalledTimes(1)
      await flush(1000)
      expect(mocks.dialLead).toHaveBeenCalledTimes(2)
      const first = mocks.dialLead.mock.calls[0][0]
      const second = mocks.dialLead.mock.calls[1][0]
      expect(second.propertyId).toBe(first.propertyId)
      expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
    })

    it("shows a denial as-is and never retries", async () => {
      mocks.dialLead.mockResolvedValue({ ok: false, code: "denied", message: "That phone number is on the Do Not Call list." })
      renderClient({ dialpad })
      await click(screen.getByRole("button", { name: "Start call property-1" }))
      expect(screen.getByTestId("dial-status")).toHaveTextContent("That phone number is on the Do Not Call list.")
      await flush(120_000)
      expect(mocks.dialLead).toHaveBeenCalledTimes(1)
    })
  })

  describe("auto-open of the post-call prompt", () => {
    const oldest = prompt()
    const newer = prompt({
      attemptId: "attempt-new", propertyId: "property-2", callActivityId: "activity-new",
      endedAt: "2026-10-05T10:05:00Z", outcomeGuess: "no_answer", voicemail: false,
    })

    it("opens the oldest prompt first, pre-sets its outcome, acknowledges on close, then opens the next", async () => {
      mocks.poll.mockResolvedValue(pollState({ prompts: [newer, oldest] }))
      renderClient({ postCallPrompt: true, callFeatures: flags({ autoPrompt: true }) })
      await flush()
      expect(screen.getAllByTestId("post-call-prompt")).toHaveLength(1)
      expect(screen.getByTestId("post-call-outcome-voicemail")).toHaveAttribute("aria-checked", "true")
      expect(screen.getByTestId("post-call-outcome-no-answer")).toHaveAttribute("aria-checked", "false")
      expect(ackCalls()).toHaveLength(0)

      await click(screen.getByRole("button", { name: "Cancel" }))
      expect(ackCalls()[0]).toEqual(["attempt-old", "dismissed"])
      // The poll still lists the acknowledged attempt: only the other one may open.
      await flush(10_000)
      expect(screen.getAllByTestId("post-call-prompt")).toHaveLength(1)
      expect(screen.getByTestId("post-call-outcome-no-answer")).toHaveAttribute("aria-checked", "true")

      await click(screen.getByRole("button", { name: "Cancel" }))
      expect(ackCalls()).toEqual([["attempt-old", "dismissed"], ["attempt-new", "dismissed"]])
      await flush(30_000)
      expect(screen.queryByTestId("post-call-prompt")).not.toBeInTheDocument()
      expect(ackCalls()).toHaveLength(2)
    })

    it("never opens over a dialog the rep already has open", async () => {
      renderClient({ postCallPrompt: true, callFeatures: flags({ autoPrompt: true }) })
      await flush()
      expect(mocks.poll).toHaveBeenCalledTimes(1)
      await click(screen.getByRole("button", { name: "Log attempt property-2" }))
      expect(screen.getAllByTestId("post-call-prompt")).toHaveLength(1)
      mocks.poll.mockResolvedValue(pollState({ prompts: [oldest] }))
      await flush(30_000)
      // The poll is suspended while the manual dialog is open.
      expect(mocks.poll).toHaveBeenCalledTimes(1)
      expect(screen.getAllByTestId("post-call-prompt")).toHaveLength(1)
      expect(screen.getByTestId("post-call-outcome-voicemail")).toHaveAttribute("aria-checked", "false")
      expect(ackCalls()).toHaveLength(0)

      await click(screen.getByRole("button", { name: "Cancel" }))
      await flush()
      expect(ackCalls()).toHaveLength(0)
      expect(screen.getAllByTestId("post-call-prompt")).toHaveLength(1)
      expect(screen.getByTestId("post-call-outcome-voicemail")).toHaveAttribute("aria-checked", "true")
    })

    it("ignores a stale prompt for a lead that is no longer in the queue", async () => {
      mocks.poll.mockResolvedValue(pollState({ prompts: [prompt({ propertyId: "reassigned-away" })] }))
      renderClient({ postCallPrompt: true, callFeatures: flags({ autoPrompt: true }) })
      await flush(30_000)
      expect(mocks.poll).toHaveBeenCalled()
      expect(screen.queryByTestId("post-call-prompt")).not.toBeInTheDocument()
      expect(ackCalls()).toHaveLength(0)
    })

    it("does not open anything when autoPrompt is off", async () => {
      mocks.poll.mockResolvedValue(pollState({ prompts: [oldest] }))
      renderClient({ postCallPrompt: true, callFeatures: flags({ autoPrompt: false }) })
      await flush(30_000)
      expect(mocks.poll).toHaveBeenCalled()
      expect(screen.queryByTestId("post-call-prompt")).not.toBeInTheDocument()
      expect(ackCalls()).toHaveLength(0)
    })
  })

  describe("idempotency keys across repeated calls", () => {
    it("mints a new key and dials again once the previous call to the same lead has finished", async () => {
      mocks.dialLead.mockResolvedValueOnce({ ...dialOk, intentId: "intent-1" })
      mocks.dialLead.mockResolvedValueOnce({ ...dialOk, intentId: "intent-2" })
      mocks.status.mockImplementation(async (id: string) => callStatus(id, "ended"))
      renderClient({ dialpad })
      await click(screen.getByRole("button", { name: "Start call property-1" }))
      await flush(0)
      await click(screen.getByRole("button", { name: "Start call property-1" }))
      expect(mocks.dialLead).toHaveBeenCalledTimes(2)
      const [first, second] = mocks.dialLead.mock.calls.map((c) => c[0])
      expect(second.propertyId).toBe(first.propertyId)
      expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
    })

    it("keeps the same key after an expired call so a retry reuses it instead of duplicating", async () => {
      mocks.dialLead.mockResolvedValueOnce({ ...dialOk, intentId: "intent-1" })
      mocks.dialLead.mockResolvedValueOnce({ ...dialOk, intentId: "intent-1" })
      mocks.status.mockImplementation(async (id: string) => callStatus(id, "expired"))
      renderClient({ dialpad })
      await click(screen.getByRole("button", { name: "Start call property-1" }))
      await flush(0)
      await click(screen.getByRole("button", { name: "Start call property-1" }))
      expect(mocks.dialLead).toHaveBeenCalledTimes(2)
      const [first, second] = mocks.dialLead.mock.calls.map((c) => c[0])
      expect(second.idempotencyKey).toBe(first.idempotencyKey)
    })

    it("does not dial a second time while the first call is still in flight", async () => {
      mocks.dialLead.mockResolvedValue({ ...dialOk, intentId: "intent-1" })
      mocks.status.mockImplementation(async (id: string) => callStatus(id, "dialing"))
      renderClient({ dialpad })
      await click(screen.getByRole("button", { name: "Start call property-1" }))
      await click(screen.getByRole("button", { name: "Start call property-1" }))
      await click(screen.getByRole("button", { name: "Start call property-2" }))
      expect(mocks.dialLead).toHaveBeenCalledTimes(1)
    })

    it("keeps the same key when the request threw, so a retry cannot double-dial", async () => {
      mocks.dialLead.mockRejectedValueOnce(new Error("network"))
      mocks.dialLead.mockResolvedValueOnce({ ...dialOk, intentId: "intent-1" })
      renderClient({ dialpad })
      await click(screen.getByRole("button", { name: "Start call property-1" }))
      await click(screen.getByRole("button", { name: "Start call property-1" }))
      expect(mocks.dialLead).toHaveBeenCalledTimes(2)
      expect(mocks.dialLead.mock.calls[1][0].idempotencyKey).toBe(mocks.dialLead.mock.calls[0][0].idempotencyKey)
    })

    it("Dismiss during the rate-limit countdown cancels the automatic retry", async () => {
      mocks.dialLead.mockResolvedValueOnce({ ok: false, code: "rate_limited", message: "Slow down", retryAfterSeconds: 3, freshAttemptKey: true })
      renderClient({ dialpad })
      await click(screen.getByRole("button", { name: "Start call property-1" }))
      await flush(1000)
      await click(screen.getByRole("button", { name: "Dismiss" }))
      expect(screen.queryByTestId("dial-status")).not.toBeInTheDocument()
      await flush(10_000)
      expect(mocks.dialLead).toHaveBeenCalledTimes(1)
    })
  })

  describe("auto-prompt waits", () => {
    const waiting = prompt()
    const freshPoll = () => ({ ok: true as const, state: { ...EMPTY_CALL_STATE, features: { autoPrompt: true, callbackAlert: true }, prompts: [{ ...waiting }] } })

    it("holds while a dial is in flight and opens after the call ends", async () => {
      mocks.dialLead.mockResolvedValue({ ...dialOk, intentId: "intent-1" })
      let state = "dialing"
      mocks.status.mockImplementation(async (id: string) => callStatus(id, state))
      renderClient({ dialpad, postCallPrompt: true, callFeatures: flags({ autoPrompt: true, clickToDial: true }) })
      await flush()
      await click(screen.getByRole("button", { name: "Start call property-2" }))
      mocks.poll.mockImplementation(async () => freshPoll())
      await flush(10_000)
      expect(screen.queryByTestId("post-call-prompt")).not.toBeInTheDocument()
      state = "ended"
      await flush(10_000)
      expect(screen.getAllByTestId("post-call-prompt")).toHaveLength(1)
    })

    it("holds while any other dialog is open in the document, then opens once it closes", async () => {
      const foreign = document.createElement("div")
      foreign.setAttribute("role", "dialog")
      foreign.setAttribute("data-state", "open")
      document.body.appendChild(foreign)
      try {
        mocks.poll.mockImplementation(async () => freshPoll())
        renderClient({ postCallPrompt: true, callFeatures: flags({ autoPrompt: true }) })
        await flush(30_000)
        expect(mocks.poll).toHaveBeenCalled()
        expect(screen.queryByTestId("post-call-prompt")).not.toBeInTheDocument()
        foreign.remove()
        await flush(10_000)
        expect(screen.getAllByTestId("post-call-prompt")).toHaveLength(1)
      } finally {
        foreign.remove()
      }
    })
  })

  describe("callback due banner", () => {
    it("shows the banner, pins the row first with its reason, and dials once from the banner", async () => {
      mocks.poll.mockResolvedValue(pollState({ callbacksDue: [due()] }))
      let resolve!: (value: unknown) => void
      mocks.dialLead.mockReturnValue(new Promise((r) => { resolve = r }))
      renderClient({ initialStrip: strip(), dialpad, callFeatures: flags({ clickToDial: true, callbackAlert: true }) })
      await flush()
      expect(screen.getByTestId("callback-due-banner")).toBeInTheDocument()
      const listed = screen.getAllByTestId(/^call-next-row-/).map((el) => el.getAttribute("data-testid"))
      expect(listed[0]).toBe("call-next-row-property-2")
      expect(screen.getByTestId("call-next-reason-property-2")).toHaveTextContent("Callback due now")
      expect(screen.getByTestId("call-next-reason-property-1")).not.toHaveTextContent("Callback due now")

      const call = screen.getByTestId("callback-call-property-2")
      await click(call)
      await click(call)
      expect(mocks.dialLead).toHaveBeenCalledTimes(1)
      expect(mocks.dialLead).toHaveBeenCalledWith(expect.objectContaining({ propertyId: "property-2", contactId: "contact-2" }))
      await act(async () => { resolve(dialOk) })
      await flush()
      expect(screen.getByTestId("callback-call-property-2")).toBeDisabled()
      expect(mocks.dialLead).toHaveBeenCalledTimes(1)
    })

    it("shows no banner and no pin when callbackAlert is off", async () => {
      mocks.poll.mockResolvedValue(pollState({ callbacksDue: [due()] }))
      renderClient({ initialStrip: strip(), dialpad, callFeatures: flags({ callbackAlert: false }) })
      await flush()
      expect(screen.queryByTestId("callback-due-banner")).not.toBeInTheDocument()
      const listed = screen.getAllByTestId(/^call-next-row-/).map((el) => el.getAttribute("data-testid"))
      expect(listed[0]).toBe("call-next-row-property-1")
      expect(screen.getByTestId("call-next-reason-property-2")).not.toHaveTextContent("Callback due now")
    })
  })
})
