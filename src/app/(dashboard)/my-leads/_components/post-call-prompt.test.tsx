vi.mock("@/lib/sequences/drip-progress", () => ({ listDripProgress: vi.fn(async (): Promise<unknown[]> => []) }))
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }))
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const dripActions = vi.hoisted(() => ({ listDripChoices: vi.fn(), startDripForLeads: vi.fn(), changeDripAction: vi.fn() }))
vi.mock("@/app/(dashboard)/sequences/actions", () => dripActions)

import { quickPickDueAt } from "@/lib/my-leads/quick-picks"
import { acquisitionsManagerStorageKey, PostCallPrompt, type PostCallPromptProps } from "./post-call-prompt"
import { WorkflowRecoveryContext } from "./workflow-form"

const baseProps: PostCallPromptProps = {
  open: true,
  propertyId: "property-1",
  propertyLabel: "123 Main Street",
  onOpenChange: vi.fn(),
  onSubmit: vi.fn(async () => ({ ok: true as const })),
  viewerUserId: "rep-1",
  viewerLabel: "Maria",
}
const linked = { initialCallActivityId: "call-1" }
const refs = (over: Record<string, unknown> = {}) => [{ id: "call-1", label: "9 AM Central", provider: "sandra_softphone", callOutcome: null, talkSeconds: null, ...over }]

function setup(props: Partial<PostCallPromptProps> = {}) {
  const onSubmit = vi.fn(async () => ({ ok: true as const }))
  const view = render(<PostCallPrompt {...baseProps} onSubmit={onSubmit} {...props} />)
  return { onSubmit, user: userEvent.setup(), ...view }
}
const outcome = (name: string) => within(screen.getByTestId("post-call-outcome")).getByRole("radio", { name })

describe("PostCallPrompt", () => {
  beforeEach(() => {
    window.localStorage.clear()
    dripActions.listDripChoices.mockResolvedValue({ ok: true, data: [{ id: "drip-1", name: "Seller follow-up", textCount: 4, days: 90, firstSend: "Today" }] })
    dripActions.startDripForLeads.mockResolvedValue({ ok: true, data: { results: [{ propertyId: "property-1", status: "enrolled", reason: "Enrolled" }] } })
  })

  it("renders the stable test ids and the four outcomes", () => {
    setup()
    expect(screen.getByTestId("post-call-prompt")).toBeVisible()
    expect(screen.getByTestId("post-call-note")).toBeVisible()
    for (const id of ["post-call-pick-tomorrow", "post-call-pick-3-days", "post-call-pick-next-week", "post-call-pick-pick"]) expect(screen.getByTestId(id)).toBeVisible()
    expect(within(screen.getByTestId("post-call-outcome")).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Reached", "No answer", "Voicemail", "Wrong number"])
  })

  it.each([
    [{ callOutcome: "voicemail" }, "Voicemail"],
    [{ callOutcome: "connected_human" }, "Reached"],
    [{ callOutcome: "busy" }, "No answer"],
  ])("pre-guesses the outcome from the linked call %j", (over, label) => {
    setup({ ...linked, callReferenceOptions: refs(over) })
    expect(outcome(label)).toBeChecked()
  })

  it("leaves the outcome unset when the call gives no clue, and the rep can change a guess", async () => {
    const first = setup({ ...linked, callReferenceOptions: refs({ callOutcome: "failed" }) })
    expect(within(screen.getByTestId("post-call-outcome")).queryByRole("radio", { checked: true })).toBeNull()
    first.unmount()
    const { user } = setup({ ...linked, callReferenceOptions: refs({ callOutcome: "voicemail" }) })
    await user.click(outcome("Wrong number"))
    expect(outcome("Wrong number")).toBeChecked()
    expect(outcome("Voicemail")).not.toBeChecked()
  })

  it("voicemail hides the SMS follow-up section; no answer shows it and requires its fields", async () => {
    const { user, onSubmit } = setup({ ...linked, callReferenceOptions: refs() })
    await user.click(outcome("Voicemail"))
    expect(screen.queryByText("Required follow-up text")).not.toBeInTheDocument()
    await user.click(outcome("No answer"))
    expect(screen.getByText("Required follow-up text")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText("Choose a curated follow-up template.")).toBeVisible()
    await user.selectOptions(screen.getByLabelText("Curated follow-up template"), "no-answer-callback-time")
    await user.clear(screen.getByLabelText("Acquisitions manager"))
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByText("Enter the acquisitions manager.")).toBeVisible()
    expect(onSubmit).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText("Acquisitions manager"), "Jordan")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "no_answer", source: "sandra", callActivityId: "call-1",
      followUp: expect.objectContaining({ acquisitionsManager: "Jordan", templateId: "no-answer-callback-time" }),
    }))
  })

  it("prefills the acquisitions manager from the viewer, and remembers the last one per user", async () => {
    const first = setup({ ...linked, callReferenceOptions: refs() })
    await first.user.click(outcome("No answer"))
    expect(screen.getByLabelText("Acquisitions manager")).toHaveValue("Maria")
    await first.user.selectOptions(screen.getByLabelText("Curated follow-up template"), "no-answer-callback-time")
    await first.user.clear(screen.getByLabelText("Acquisitions manager"))
    await first.user.type(screen.getByLabelText("Acquisitions manager"), "Jordan")
    await first.user.click(screen.getByRole("button", { name: "Save" }))
    expect(window.localStorage.getItem(acquisitionsManagerStorageKey("rep-1"))).toBe("Jordan")
    first.unmount()
    const second = setup({ ...linked, callReferenceOptions: refs() })
    await second.user.click(outcome("No answer"))
    expect(screen.getByLabelText("Acquisitions manager")).toHaveValue("Jordan")
  })

  it("works when storage throws", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked") })
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked") })
    try {
      const { user, onSubmit } = setup({ ...linked, callReferenceOptions: refs() })
      await user.click(outcome("No answer"))
      expect(screen.getByLabelText("Acquisitions manager")).toHaveValue("Maria")
      await user.selectOptions(screen.getByLabelText("Curated follow-up template"), "no-answer-callback-time")
      await user.click(screen.getByRole("button", { name: "Save" }))
      expect(onSubmit).toHaveBeenCalledTimes(1)
    } finally { getItem.mockRestore(); setItem.mockRestore() }
  })

  it("shows the recording link only for a manual DialPad call and the occurred-at field only for manual sources", async () => {
    const { user } = setup({ ...linked, callReferenceOptions: refs() })
    // A linked Sandra call: no recording link, no occurred-at.
    expect(screen.queryByLabelText(/Recording link/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText("When did it occur?")).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText("Where was this call?"), "dialpad")
    expect(screen.getByLabelText("Recording link (required)")).toBeVisible()
    expect(screen.getByLabelText("When did it occur?")).toBeVisible()
    await user.selectOptions(screen.getByLabelText("Where was this call?"), "manual")
    expect(screen.queryByLabelText(/Recording link/)).not.toBeInTheDocument()
    expect(screen.getByLabelText("When did it occur?")).toBeVisible()
  })

  it("defaults to DialPad without a linked call and Sandra call with one", () => {
    const first = setup()
    expect(screen.getByLabelText("Where was this call?")).toHaveValue("dialpad")
    first.unmount()
    setup({ ...linked, callReferenceOptions: refs() })
    expect(screen.getByLabelText("Where was this call?")).toHaveValue("sandra")
  })

  it("saves with only an outcome (note, next step and drip are optional) and the note never goes to the attempt", async () => {
    const { user, onSubmit } = setup({ ...linked, callReferenceOptions: refs() })
    expect(screen.getByTestId("post-call-no-next-step")).toHaveTextContent("No next step yet")
    await user.click(outcome("Reached"))
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "reached", note: null, source: "sandra", kind: "call", recordingUrl: null,
      postCall: { submissionId: expect.any(String), note: null, nextStep: null },
    }))
  })

  it("does not show the no-next-step hint when the lead already has one", () => {
    setup({ ...linked, callReferenceOptions: refs(), nextStepAt: "2999-01-01T00:00:00Z" })
    expect(screen.queryByTestId("post-call-no-next-step")).not.toBeInTheDocument()
  })

  it("requires an outcome to save; Cancel leaves it not set without submitting", async () => {
    const onOpenChange = vi.fn()
    const { user, onSubmit } = setup({ ...linked, callReferenceOptions: refs(), onOpenChange })
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText("Choose what happened on the call.")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it.each([
    ["post-call-pick-tomorrow", "tomorrow"],
    ["post-call-pick-3-days", "three_days"],
    ["post-call-pick-next-week", "next_week"],
  ] as const)("quick pick %s sends the quickPickDueAt time with its note", async (testId, pick) => {
    const { user, onSubmit } = setup({ ...linked, callReferenceOptions: refs() })
    await user.click(outcome("Voicemail"))
    await user.type(screen.getByTestId("post-call-note"), "Call back")
    await user.click(screen.getByTestId(testId))
    expect(screen.getByTestId(testId)).toHaveAttribute("aria-pressed", "true")
    await user.click(screen.getByRole("button", { name: "Save" }))
    const payload = (onSubmit.mock.calls[0] as unknown[])[0] as { postCall: { note: string; nextStep: { pick: string; dueAt: string } } }
    expect(payload.postCall.note).toBe("Call back")
    expect(payload.postCall.nextStep.pick).toBe(pick)
    expect(payload.postCall.nextStep.dueAt).toBe(quickPickDueAt(pick, new Date()).toISOString())
  })

  it("Pick needs a future time the rep chose", async () => {
    const { user, onSubmit } = setup({ ...linked, callReferenceOptions: refs() })
    await user.click(outcome("Reached"))
    await user.click(screen.getByTestId("post-call-pick-pick"))
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText("Choose a date and time.")).toBeVisible()
    fireEvent.change(screen.getByLabelText("Call again at"), { target: { value: "2020-01-01T09:00" } })
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByText("Choose a time in the future.")).toBeVisible()
    fireEvent.change(screen.getByLabelText("Call again at"), { target: { value: "2099-01-05T09:30" } })
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      postCall: expect.objectContaining({ nextStep: { pick: "custom", dueAt: "2099-01-05T15:30:00.000Z" } }),
    }))
  })

  it("keeps the drip picker after save, with receipt lines, follow-on buttons and a disabled Send contract", async () => {
    const onReadyForOffer = vi.fn()
    const onDeadNurture = vi.fn()
    const { user } = setup({
      ...linked, callReferenceOptions: refs(), onReadyForOffer, onDeadNurture,
      extras: { status: "done", result: { ok: true, note: "saved", nextStep: "created" } },
    })
    await user.click(outcome("Reached"))
    await user.click(screen.getByTestId("post-call-pick-tomorrow"))
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByRole("button", { name: /Seller follow-up/ })).toBeVisible()
    expect(screen.getByTestId("post-call-receipt")).toHaveTextContent(/Attempt saved · Note saved · Next step set for/)
    await user.click(screen.getByTestId("post-call-ready-for-offer"))
    await user.click(screen.getByTestId("post-call-dead-nurture"))
    expect(onReadyForOffer).toHaveBeenCalledOnce()
    expect(onDeadNurture).toHaveBeenCalledOnce()
    expect(screen.queryByTestId("post-call-send-contract")).not.toBeInTheDocument()
    expect(screen.queryByText("Send contract")).not.toBeInTheDocument()
  })

  it("an unknown call outcome leaves the outcome unselected even with talk time", () => {
    setup({ ...linked, callReferenceOptions: refs({ provider: "dialpad", callOutcome: "unknown", talkSeconds: 90 }) })
    expect(within(screen.getByTestId("post-call-outcome")).queryByRole("radio", { checked: true })).toBeNull()
  })

  it.each([
    ["failed", { ok: true as const, note: "failed" as const, nextStep: "skipped" as const, message: "Note not saved: no" }],
    ["skipped", { ok: true as const, note: "skipped" as const, nextStep: "skipped" as const, message: "Note not saved yet" }],
    ["whole request failed", { ok: false as const, message: "down" }],
  ])("shows the typed note with a copy button when the note was %s", async (_name, result) => {
    const { user } = setup({ ...linked, callReferenceOptions: refs(), extras: { status: "done", result } })
    await user.click(outcome("Reached"))
    await user.type(screen.getByTestId("post-call-note"), "Seller wants 120k")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByTestId("post-call-unsaved-note")).toHaveTextContent("Seller wants 120k")
    await user.click(screen.getByTestId("post-call-copy-note"))
    expect(await navigator.clipboard.readText()).toBe("Seller wants 120k")
  })

  it("does not show the unsaved-note box when the note saved", async () => {
    const { user } = setup({ ...linked, callReferenceOptions: refs(), extras: { status: "done", result: { ok: true, note: "saved", nextStep: "skipped" } } })
    await user.click(outcome("Reached"))
    await user.type(screen.getByTestId("post-call-note"), "kept")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByTestId("post-call-receipt")).toBeVisible()
    expect(screen.queryByTestId("post-call-unsaved-note")).not.toBeInTheDocument()
  })

  it("offers Retry only when an extra failed", async () => {
    const onRetryExtras = vi.fn()
    const { user } = setup({
      ...linked, callReferenceOptions: refs(), onRetryExtras,
      extras: { status: "done", result: { ok: true, note: "failed", nextStep: "skipped", message: "Note not saved: no" } },
    })
    await user.click(outcome("Reached"))
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByTestId("post-call-receipt")).toHaveTextContent("Attempt saved · Note not saved")
    await user.click(screen.getByTestId("post-call-retry-extras"))
    expect(onRetryExtras).toHaveBeenCalledOnce()
  })

  it("freezes a recorded no-answer attempt (receipt) instead of allowing a second save", async () => {
    const onSubmit = vi.fn(async () => ({ ok: true as const, attemptRecorded: true as const, followUp: { status: "required" as const, message: "Still needs sending" } }))
    const user = userEvent.setup()
    render(<PostCallPrompt {...baseProps} {...linked} callReferenceOptions={refs()} onSubmit={onSubmit} />)
    await user.click(outcome("No answer"))
    await user.selectOptions(screen.getByLabelText("Curated follow-up template"), "no-answer-callback-time")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByRole("button", { name: "Attempt recorded" })).toBeDisabled()
    expect(outcome("Voicemail")).toBeDisabled()
    expect(screen.getByTestId("post-call-receipt")).toHaveTextContent("Attempt saved")
  })

  it("restores a frozen reconciliation payload and locks the form", () => {
    const reconciliation = { command: "log-attempt", payload: { source: "dialpad", outcome: "voicemail", occurredAt: "2026-09-12T14:00:00.000Z", note: null, recordingUrl: "https://dialpad.example/r/1", callActivityId: null } }
    render(
      <WorkflowRecoveryContext.Provider value={{ message: "m", blocked: false, busy: false, refresh: vi.fn(), reconciliation, confirmClose: () => true }}>
        <PostCallPrompt {...baseProps} />
      </WorkflowRecoveryContext.Provider>,
    )
    expect(outcome("Voicemail")).toBeChecked()
    expect(outcome("Voicemail")).toBeDisabled()
    expect(screen.getByLabelText("Recording link (required)")).toHaveValue("https://dialpad.example/r/1")
    expect(screen.getByRole("button", { name: "Reconcile saved change" })).toBeVisible()
  })
})

describe("PostCallPrompt dock variant", () => {
  beforeEach(() => {
    window.localStorage.clear()
    dripActions.listDripChoices.mockResolvedValue({ ok: true, data: [] })
  })

  it("renders inline with data-variant=dock and no dialog", () => {
    setup({ variant: "dock" })
    expect(screen.getByTestId("post-call-prompt")).toHaveAttribute("data-variant", "dock")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("shows the four outcomes and Save, without Cancel", () => {
    setup({ variant: "dock" })
    expect(within(screen.getByTestId("post-call-outcome")).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Reached", "No answer", "Voicemail", "Wrong number"])
    expect(screen.getByRole("button", { name: "Save" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull()
  })

  it("still submits once with the chosen outcome", async () => {
    const { user, onSubmit } = setup({ variant: "dock", ...linked, callReferenceOptions: refs() })
    await user.click(outcome("Reached"))
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "reached" }))
  })
})


it("offers explicit replacement after saving the attempt", async () => {
  const { listDripProgress } = await import("@/lib/sequences/drip-progress")
  vi.mocked(listDripProgress).mockResolvedValue([{ propertyId: "property-1", enrollmentId: "existing", sequenceId: "old", sequenceName: "Talking price", enrollmentStatus: "paused" }] as Awaited<ReturnType<typeof listDripProgress>>)
  dripActions.listDripChoices.mockResolvedValue({ok:true,data:[{id:"drip-1",name:"Seller follow-up",textCount:4,days:90,firstSend:"Today"}]})
  dripActions.changeDripAction.mockResolvedValue({ok:true,data:{status:"enrolled",reason:"Enrolled"}})
  const onSubmit = vi.fn(async () => ({ ok:true as const, attemptRecorded:true as const }))
  const onOpenChange = vi.fn()
  const user = userEvent.setup()
  setup({ onSubmit, onOpenChange })
  await user.click(outcome("Reached"))
  await user.click(screen.getByRole("button", {name:"Save"}))
  expect(await screen.findByText(/Current drip:/)).toHaveTextContent("Talking price (paused)")
  await user.click(screen.getByRole("button", {name:/Seller follow-up/}))
  expect(dripActions.changeDripAction).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", {name:"Switch to selected drip"}))
  expect(dripActions.changeDripAction).toHaveBeenCalledWith("existing", "drip-1")
  expect(onSubmit).toHaveBeenCalledOnce()
  expect(onOpenChange).toHaveBeenCalledWith(false)
  vi.mocked(listDripProgress).mockResolvedValue([])
})
