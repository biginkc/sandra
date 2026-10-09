vi.mock("@/lib/sequences/drip-progress", () => ({ listDripProgress: vi.fn(async () => []) }))
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }))
import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { renderWithDialpad as render } from "@/components/dialpad/test-shell"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"
import { DailyCallClock } from "./_components/daily-call-clock"
import { EMPTY_CALL_STATE } from "@/lib/my-leads/call-state"

const mocks = vi.hoisted(() => ({
  routerRefresh: vi.fn(),
  submitMyLeadCommand: vi.fn(),
  submitMyLeadHandoffDrip: vi.fn(),
  loadMyLeads: vi.fn(),
  loadMyLeadRow: vi.fn(),
  loadMyLeadCallReferences: vi.fn(),
  realQueue: false,
  dialLead: vi.fn(),
  listDripChoices: vi.fn(async () => ({ ok: true, data: [{ id: 'drip-1', name: 'Seller follow-up', textCount: 4, days: 90, firstSend: 'Today' }] })),
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
  loadMyLeadRow: mocks.loadMyLeadRow,
  loadMyLeadsStage: vi.fn(),
  loadMyLeadDetail: vi.fn(),
  loadMyLeadCallReferences: mocks.loadMyLeadCallReferences,
  submitMyLeadCommand: mocks.submitMyLeadCommand,
  submitMyLeadHandoffDrip: mocks.submitMyLeadHandoffDrip,
  changeAcquisitionDesignation: vi.fn(),
  changeAcquisitionSettings: vi.fn(),
}))

vi.mock("@/app/(dashboard)/sequences/actions", () => ({
  listDripChoices: mocks.listDripChoices,
  startDripForLeads: vi.fn(),
  changeDripAction: vi.fn(),
}))

vi.mock("./dialpad-actions", () => ({
  dialLeadAction: mocks.dialLead,
  getDialpadCallStatusAction: vi.fn(async () => ({ ok: false, code: "not_configured", message: "" })),
  cancelDialpadCallAction: vi.fn(),
  ensureDialpadBindingAction: vi.fn(),
}))
vi.mock("./call-state-actions", () => ({
  pollMyLeadsCallStateAction: vi.fn(async () => ({ ok: true, state: EMPTY_CALL_STATE })),
  acknowledgeCallPromptAction: vi.fn(async () => ({ ok: true, status: "acknowledged" })),
}))

vi.mock("./rep-sms-composer", () => ({ RepSmsComposer: () => null }))
vi.mock("./_components/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_components/queue")>()
  const stubs = ({
  MyLeadsQueue: ({
    stages,
    search,
    onSearchChange,
    canSelectRep,
    selectedRepId,
    repOptions,
    onRepChange,
    onStageAction,
    onReviewingChange,
    kpis: tiles,
  }: React.ComponentProps<typeof actual.MyLeadsQueue>) => {
    const [expanded, setExpanded] = React.useState(false)
    const row = stages.not_contacted?.rows[0]
    return (
      <section aria-label="Mock My Leads queue">
        <span data-testid="attempt-count">{tiles.attempts}</span>
        <DailyCallClock kpis={tiles} />
        <button onClick={() => row && onStageAction("log-attempt", row)}>Log attempt</button>
        <button onClick={() => row && onStageAction("log-offer", row)}>Log offer</button>
        <button onClick={() => row && onStageAction("start-call", row)}>Start call</button>
        <button onClick={() => row && onStageAction("ready-for-offer", row)}>Ready for offer</button>
        <button onClick={() => row && onStageAction("handoff", row)}>Handoff</button>
        <span data-testid="queue-address">{row?.address}</span>
        <input aria-label="Search My Leads" value={search} onChange={(event) => onSearchChange(event.target.value)} />
        {canSelectRep && (
          <select aria-label="Acquisitions member" value={selectedRepId} onChange={(event) => onRepChange(event.target.value)}>
            {repOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        )}
        <button type="button" onClick={() => {setExpanded(true);onReviewingChange?.(true)}}>
          Expand details
        </button>
        {expanded && <div data-testid="mounted-detail">Details remain mounted</div>}
      </section>
    )
  },
})
  return { MyLeadsQueue: (props: React.ComponentProps<typeof actual.MyLeadsQueue>) => mocks.realQueue ? React.createElement(actual.MyLeadsQueue,props) : React.createElement(stubs.MyLeadsQueue,props) }
})



import type { AcquisitionKpis, AcquisitionRoster, QueueSnapshot } from "@/lib/my-leads/queries"
import type { MyLeadDripSnapshot } from "@/lib/my-leads/drip-queries"
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
  contactWithoutFollowUp: 2, needsOffers: 3, appointmentsOverdue: 4, lastAttemptAt: null, asOf: "2026-09-11T14:00:00Z", missingRecordings: 1, recordingExpectationUnknown: 0, averageTalkSeconds: 180, talkTimeSamples: 1, talkTimeUnknown: 0, conversationsOverFiveMinutes: 0,
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

/**
 * Default single-row lookup: the database truth is the most recent successful queue read
 * (or the initial snapshot). Tests that need a specific lookup override it after rendering.
 */
function installDefaultRowLookup(initial: QueueSnapshot, initialDrips: MyLeadDripSnapshot | null) {
  mocks.loadMyLeadRow.mockImplementation(async ({ propertyId }: { propertyId: string }) => {
    const settled = [...mocks.loadMyLeads.mock.settledResults].reverse().find((r) => r.type === "fulfilled" && (r.value as { ok?: boolean })?.ok)
    const read = (settled?.value as { snapshot: QueueSnapshot; drips?: MyLeadDripSnapshot | null } | undefined) ?? { snapshot: initial, drips: initialDrips }
    const rows = [
      ...Object.values(read.snapshot.stages).flatMap((page) => page?.rows ?? []),
      ...[...(read.drips?.active ?? []), ...(read.drips?.replied ?? [])].flatMap((drip) => (drip.queueRow ? [drip.queueRow] : [])),
    ]
    const row = rows.find((candidate) => candidate.propertyId === propertyId)
    return row ? { ok: true, lookup: { status: "found", row, snapshotAt: read.snapshot.snapshotAt } } : { ok: true, lookup: { status: "unavailable", reason: "not_found" } }
  })
}

function renderClient(initialSnapshot: QueueSnapshot, initialKpis = kpis, initialDrips:MyLeadDripSnapshot|null=null, dialpad?: React.ComponentProps<typeof MyLeadsClient>["dialpad"]) {
  installDefaultRowLookup(initialSnapshot, initialDrips)
  return render(
    <MyLeadsClient
      viewer={viewer}
      roster={roster}
      initialMemberId={viewer.userId}
      initialSnapshot={initialSnapshot}
      initialKpis={initialKpis}
      initialDrips={initialDrips}
      dialpad={dialpad}
    />,
  )
}

describe("MyLeadsClient", () => {
  beforeEach(() => {
    mocks.loadMyLeads.mockReset()
    mocks.submitMyLeadCommand.mockReset()
    mocks.loadMyLeadCallReferences.mockReset()
    mocks.realQueue = false
    mocks.dialLead.mockReset()
  })

  it("opens Log attempt for a pinned reply outside the first 20 rows", async()=>{
    const first=snapshot("Loaded Lane");
    const template=first.stages.not_contacted!.rows[0];
    first.stages.not_contacted!.rows=Array.from({length:20},(_,index)=>({...template,propertyId:`loaded-${index}`}));
    first.stages.not_contacted!.totalCount=21;
    const pinned={...template,propertyId:'pinned-reply',address:'Pinned Reply Lane'};
    const drips:MyLeadDripSnapshot={active:[],replied:[{propertyId:pinned.propertyId,enrollmentId:'enrollment',enrollmentStatus:'paused',
      sequenceId:'sequence',sequenceName:'Follow-up',step:1,totalSteps:2,nextTextAt:null,lastText:null,
      status:'Replied',reason:null,stage:'not_contacted',repliedAt:'2026-09-11T14:00:00Z',queueRow:pinned}],
      repliedCount:1,counts:{not_contacted:0,contacted:0,needs_offer:0,offer_sent:0,under_contract:0}};
    mocks.loadMyLeadCallReferences.mockResolvedValue({ok:true,options:[]});
    renderClient(first,kpis,drips);
    expect(screen.getByTestId('queue-address')).toHaveTextContent('Pinned Reply Lane');
    await userEvent.setup().click(screen.getByRole('button',{name:'Log attempt'}));
    expect(screen.getByRole('dialog',{name:/Log an attempt/i})).toBeVisible();
    expect(mocks.loadMyLeadCallReferences).toHaveBeenCalledWith('pinned-reply','rep-1');
  });

  it("updates the visible check time every 30 seconds even when attempts do not change", async () => {
    vi.useFakeTimers()
    const initial = snapshot("106 Fixture Lane")
    mocks.loadMyLeads.mockResolvedValueOnce({ ok: true, snapshot: { ...initial, snapshotAt: "2026-09-11T14:00:30.000Z" }, kpis })
    mocks.loadMyLeads.mockResolvedValueOnce({ ok: true, snapshot: { ...initial, snapshotAt: "2026-09-11T14:01:00.000Z" }, kpis })
    const view = renderClient(initial)
    try {
      expect(screen.getByText(/Counts update every 30 seconds/)).toBeInTheDocument()
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

  it("dials through the API once per click while in flight and shows the dial status", async () => {
    const user = userEvent.setup()
    let resolve!: (value: unknown) => void
    mocks.dialLead.mockReturnValue(new Promise(r => { resolve = r }))
    const dialpad = { connectionId: "c1", binding: { status: "verified", dialpadUserId: "5551234" }, grants: [] } as React.ComponentProps<typeof MyLeadsClient>["dialpad"]
    renderClient(snapshot("106 Fixture Lane"), kpis, null, dialpad)
    await user.click(screen.getByRole("button", { name: "Start call" }))
    await user.click(screen.getByRole("button", { name: "Start call" }))
    expect(mocks.dialLead).toHaveBeenCalledTimes(1)
    expect(mocks.dialLead).toHaveBeenCalledWith({
      propertyId: "property-1",
      contactId: "contact-1",
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    await act(async () => { resolve({ ok: true, intentId: "intent-1", state: "awaiting_provider", uncertain: false, phoneSlot: 1 }) })
    expect(await screen.findByTestId("dial-status")).toBeInTheDocument()
    expect(mocks.dialLead).toHaveBeenCalledTimes(1)
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
    }))
  })

  it("starts on the owner's own profile and allows switching to another rep", async () => {
    const user = userEvent.setup()
    const ownerViewer = { ...viewer, userId: "owner-1", isOwner: true }
    const ownerRoster: AcquisitionRoster = {
      ...roster,
      isOwner: true,
      members: [
        ...roster.members,
        { id: "owner-1", label: "Owner", role: "owner", acquisitionsEnabled: false, active: true, hasHistory: false },
      ],
    }
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: snapshot("Other rep Lane"), kpis })
    render(<MyLeadsClient viewer={ownerViewer} roster={ownerRoster} initialMemberId="owner-1"
      initialSnapshot={snapshot("Owner Lane")} initialKpis={kpis} />)

    const picker = screen.getByRole("combobox", { name: "Acquisitions member" })
    expect(picker).toHaveValue("owner-1")
    expect(screen.getByTestId("queue-address")).toHaveTextContent("Owner Lane")
    await user.selectOptions(picker, "rep-1")
    await waitFor(() => expect(mocks.loadMyLeads).toHaveBeenCalledWith({ memberId: "rep-1", search: "", period: "today" }))
    await waitFor(() => expect(screen.getByTestId("queue-address")).toHaveTextContent("Other rep Lane"))
    expect(picker).toHaveValue("rep-1")
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


it.each(["log-offer", "log-attempt"])("retains a rapid %s opening intent until an earlier save finishes refreshing", async (nextAction) => {
  const user = userEvent.setup();
  const initial = snapshot("106 Fixture Lane");
  let release!: (value: unknown) => void;
  mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:initial,kpis});
  mocks.loadMyLeadCallReferences.mockResolvedValue({ok:true,options:[]});
  mocks.submitMyLeadCommand.mockResolvedValue({ok:true});
  renderClient(initial);
  await user.click(screen.getByRole("button",{name:"Log attempt"}));
  await user.selectOptions(screen.getByLabelText("External outcome"),"reached");
  fireEvent.change(screen.getByLabelText("When did the outreach occur?"),{target:{value:"2026-09-11T09:00"}});
  await user.click(screen.getByRole("button",{name:"Save attempt"}));
  await user.click(await screen.findByRole('button',{name:'Done without changing drip'}));
  await waitFor(()=>expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(mocks.loadMyLeads).toHaveBeenCalledTimes(1);
  // The next opening reads the lead through the single-row lookup and waits for it.
  mocks.loadMyLeadRow.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  await user.click(screen.getByRole("button",{name:nextAction==="log-offer"?"Log offer":"Log attempt"}));
  expect(screen.getByText("Loading current lead…")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async()=>{release({ok:true,lookup:{status:'found',row:initial.stages.not_contacted!.rows[0],snapshotAt:initial.snapshotAt}});});
  if(nextAction==="log-offer"){
    await user.type(screen.getByLabelText("Offer amount"),"125000.50");
    await user.selectOptions(screen.getByLabelText("Offer method"),"verbal");
    fireEvent.change(screen.getByLabelText("Offer sent"),{target:{value:"2026-09-11T10:00"}});
    fireEvent.change(screen.getByLabelText("Required follow-up"),{target:{value:"2026-09-12T10:00"}});
    await user.click(screen.getByRole("radio",{name:"No motivation provided"}));
  }else{
    await user.selectOptions(screen.getByLabelText("External outcome"),"no_answer");
    await user.type(screen.getByLabelText("Acquisitions manager"),"Jordan");
    await user.selectOptions(screen.getByLabelText("Curated follow-up template"),"no-answer-callback-time");
    fireEvent.change(screen.getByLabelText("When did the outreach occur?"),{target:{value:"2026-09-11T11:00"}});
    await user.type(screen.getByLabelText("Note (optional)"),"Second opening draft");
  }
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1);
  if(nextAction==="log-offer")expect(screen.getByLabelText("Offer amount")).toHaveValue("125000.50");
  else expect(screen.getByLabelText("Note (optional)")).toHaveValue("Second opening draft");
  await user.click(screen.getByRole("button",{name:nextAction==="log-offer"?"Save offer":"Save attempt"}));
  await waitFor(()=>expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2));
  expect(mocks.submitMyLeadCommand.mock.calls[1][0]).toBe(nextAction);
  expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toMatchObject({propertyId:"property-1",expectedEpisodeId:"episode-1",...(nextAction==="log-offer"?{amountCents:12500050}:{note:"Second opening draft",outcome:"no_answer"})});
  expect(mocks.submitMyLeadCommand.mock.calls[1][1].idempotencyKey).not.toBe(mocks.submitMyLeadCommand.mock.calls[0][1].idempotencyKey);
});

describe('stale form recovery',()=>{
  beforeEach(()=>{vi.resetAllMocks();mocks.loadMyLeadCallReferences.mockResolvedValue({ok:true,options:[]});});
  it('refreshes a stale drip handoff and retries with the current queue version',async()=>{
    const user=userEvent.setup();
    mocks.listDripChoices.mockResolvedValue({ok:true,data:[{id:'drip-1',name:'Seller follow-up',textCount:4,days:90,firstSend:'Today'}]});
    mocks.submitMyLeadHandoffDrip.mockResolvedValueOnce({ ok: false, certainty: "rejected", code: 'STALE_STATE',message:'This lead changed. Refresh before trying again.'})
      .mockResolvedValueOnce({ok:true});
    renderClient(snapshot('106 Fixture Lane'));
    await user.click(screen.getByRole('button',{name:'Handoff'}));
    await user.selectOptions(screen.getByLabelText('Handoff reason'),'not_interested');
    await user.click(await screen.findByRole('button',{name:/Seller follow-up/}));
    await user.click(screen.getByRole('button',{name:'Hand off lead'}));
    await screen.findByRole('button',{name:'Refresh'});
    expect(mocks.submitMyLeadHandoffDrip.mock.calls[0][0]).toMatchObject({expectedQueueVersion:1,sequenceId:'drip-1'});
    const fresh=snapshot('106 Fixture Lane');fresh.stages.not_contacted!.rows[0].queueVersion=2;
    mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:fresh,kpis});
    // Recovery requires the authoritative single-row lookup to succeed.
    mocks.loadMyLeadRow.mockResolvedValue({ok:true,lookup:{status:'found',row:fresh.stages.not_contacted!.rows[0],snapshotAt:fresh.snapshotAt}});
    await user.click(screen.getByRole('button',{name:'Refresh'}));
    await screen.findByText('Lead refreshed. Your draft is retained. Review it before saving.');
    expect(screen.getByLabelText('Handoff reason')).toHaveValue('not_interested');
    await user.click(screen.getByRole('button',{name:'Hand off lead'}));
    await waitFor(()=>expect(mocks.submitMyLeadHandoffDrip).toHaveBeenCalledTimes(2));
    expect(mocks.submitMyLeadHandoffDrip.mock.calls[1][0]).toMatchObject({expectedQueueVersion:2,sequenceId:'drip-1'});
  });
  async function rejectedDraft(code='STALE_STATE'){
    const user=userEvent.setup();
    mocks.submitMyLeadCommand.mockResolvedValueOnce({ok:false,certainty:code==='STALE_STATE'?'rejected':'unknown',code,message:'This lead changed. Refresh before trying again.'});
    renderClient(snapshot('106 Fixture Lane'));
    await user.click(screen.getByRole('button',{name:'Log attempt'}));
    await user.selectOptions(screen.getByLabelText('External outcome'),'reached');
    fireEvent.change(screen.getByLabelText('When did the outreach occur?'),{target:{value:'2026-09-11T09:00'}});
    await user.type(screen.getByLabelText('Note (optional)'),'Keep this original draft');
    await user.click(screen.getByRole('button',{name:'Save attempt'}));
    await screen.findByRole('button',{name:'Refresh'});
    expect(screen.getByRole('button',{name:/Save attempt|Reconcile saved change/})).toBeDisabled();
    return user;
  }
  it('refreshes version metadata while preserving the draft and only saves on explicit retry',async()=>{
    const user=await rejectedDraft();
    const fresh=snapshot('106 Fixture Lane');fresh.stages.not_contacted!.rows[0].queueVersion=2;
    mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:fresh,kpis});
    // Recovery requires the authoritative single-row lookup to succeed.
    mocks.loadMyLeadRow.mockResolvedValue({ok:true,lookup:{status:'found',row:fresh.stages.not_contacted!.rows[0],snapshotAt:fresh.snapshotAt}});
    await user.click(screen.getByRole('button',{name:'Refresh'}));
    await screen.findByText('Lead refreshed. Your draft is retained. Review it before saving.');
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('Keep this original draft');
    expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1);
    mocks.submitMyLeadCommand.mockResolvedValueOnce({ok:true});
    await user.click(screen.getByRole('button',{name:'Save attempt'}));
    await waitFor(()=>expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2));
    expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toMatchObject({expectedQueueVersion:2,expectedEpisodeId:'episode-1',note:'Keep this original draft'});
    // Refreshing a stale opening keeps the same logical submission alive. A
    // new idempotency key is reserved for an explicit close/reopen or a
    // confirmed terminal result.
    expect(mocks.submitMyLeadCommand.mock.calls[1][1].idempotencyKey).toBe(mocks.submitMyLeadCommand.mock.calls[0][1].idempotencyKey);
  });
  it('replays the original command payload after a lost response even if the draft is edited', async()=>{
    const user=userEvent.setup();
    mocks.loadMyLeadCallReferences.mockResolvedValue({ok:true,options:[]});
    mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:snapshot('106 Fixture Lane'),kpis});
    mocks.submitMyLeadCommand
      .mockRejectedValueOnce(new Error('The save response was lost'))
      .mockResolvedValueOnce({ok:true});
    renderClient(snapshot('106 Fixture Lane'));
    await user.click(screen.getByRole('button',{name:'Log attempt'}));
    await user.selectOptions(screen.getByLabelText('External outcome'),'reached');
    fireEvent.change(screen.getByLabelText('When did the outreach occur?'),{target:{value:'2026-09-11T09:00'}});
    const note=screen.getByLabelText('Note (optional)');
    await user.type(note,'Original draft');
    await user.click(screen.getByRole('button',{name:'Save attempt'}));
    await screen.findByText(/original request is preserved for reconciliation/);
    expect(note).toHaveValue('Original draft');
    expect(note).toBeDisabled();
    expect(screen.getByRole('button',{name:'Reconcile saved change'})).toBeEnabled();
    await user.click(screen.getByRole('button',{name:'Reconcile saved change'}));
    await waitFor(()=>expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2));
    expect(mocks.submitMyLeadCommand.mock.calls[0][1]).toMatchObject({note:'Original draft'});
    // The key and payload are an inseparable replay pair. The visible form is
    // frozen to the original values while the saved request is reconciled.
    expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toMatchObject({note:'Original draft'});
    expect(mocks.submitMyLeadCommand.mock.calls[1][1].idempotencyKey).toBe(mocks.submitMyLeadCommand.mock.calls[0][1].idempotencyKey);
  });
  it('ignores recovery finishing after cancellation and reopening the same lead',async()=>{
    const user=await rejectedDraft();
    let release!: (value: unknown)=>void;
    mocks.loadMyLeadRow.mockReturnValueOnce(new Promise(resolve=>{release=resolve;}));
    await user.click(screen.getByRole('button',{name:'Refresh'}));
    await user.click(screen.getByRole('button',{name:'Cancel'}));
    await user.click(screen.getByRole('button',{name:'Log attempt'}));
    await user.type(screen.getByLabelText('Note (optional)'),'New opening draft');
    const fresh=snapshot('106 Fixture Lane');fresh.stages.not_contacted!.rows[0].queueVersion=99;
    await act(async()=>release({ok:true,lookup:{status:'found',row:fresh.stages.not_contacted!.rows[0],snapshotAt:'x'}}));
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('New opening draft');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Save attempt'})).toBeEnabled();
    expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1);
  });
  it.each(['missing','different episode','failed read'])('retains draft and refuses retry after %s',async(kind)=>{
    const user=await rejectedDraft('FORBIDDEN');
    const fresh=snapshot('106 Fixture Lane');
    if(kind==='missing')fresh.stages.not_contacted!.rows=[];
    if(kind==='different episode')fresh.stages.not_contacted!.rows[0].assignmentEpisodeId='episode-2';
    mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:fresh,kpis});
    mocks.loadMyLeadRow.mockResolvedValue(kind==='failed read'?{ok:false,code:'READ_FAILED',message:'denied'}
      :kind==='missing'?{ok:true,lookup:{status:'unavailable',reason:'other_rep'}}
      :{ok:true,lookup:{status:'found',row:fresh.stages.not_contacted!.rows[0],snapshotAt:'x'}});
    await user.click(screen.getByRole('button',{name:'Refresh'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh'})).toBeEnabled());
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('Keep this original draft');
    // FORBIDDEN is an unknown outcome, so the exact original request stays locked for reconciliation.
    expect(screen.getByRole('button',{name:/Save attempt|Reconcile saved change/})).toBeDisabled();
    expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1);
  });
});


describe("current metadata for rapid workflow openings",()=>{
  const settle = { timeout: 5000 };
  beforeEach(()=>{vi.resetAllMocks();mocks.loadMyLeadCallReferences.mockResolvedValue({ok:true,options:[]});});
  async function afterReadiness(){
    const user=userEvent.setup();const initial=snapshot("106 Fixture Lane");
    let release!:(value:unknown)=>void;
    mocks.submitMyLeadCommand.mockResolvedValue({ok:true});
    renderClient(initial);
    await user.click(screen.getByRole("button",{name:"Ready for offer"}));
    fireEvent.change(screen.getByLabelText("Motivation"), { target: { value: "Seller plans to relocate." } });
    await user.selectOptions(screen.getByLabelText("Temperature (optional)"),"warm");
    await user.click(screen.getByRole("button",{name:"Save readiness"}));
    await waitFor(()=>expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), settle);
    const fresh=snapshot("106 Fixture Lane");Object.assign(fresh.stages.not_contacted!.rows[0],{queueVersion:2,sharedStatus:"interested",motivationKind:"specified",motivationText:"Seller plans to relocate.",temperature:"warm"});
    // The NEXT opening's single-row lookup is the delayed read. Tests release it with a queue-read-shaped value.
    mocks.loadMyLeadRow.mockReturnValueOnce(new Promise(resolve=>{release=resolve;}));
    const lookupOf=(value:{ok:boolean;message?:string;snapshot?:QueueSnapshot}|unknown)=>{
      const v=value as {ok:boolean;message?:string;snapshot?:QueueSnapshot};
      if(!v.ok)return {ok:false,code:'READ_FAILED',message:v.message};
      const row=v.snapshot?.stages.not_contacted?.rows[0];
      return row?{ok:true,lookup:{status:'found',row,snapshotAt:'x'}}:{ok:true,lookup:{status:'unavailable',reason:'not_found'}};
    };
    return {user,initial,fresh,release:(value:unknown)=>release(lookupOf(value))};
  }
  it.each(["offer","attempt"])("initializes next %s from saved readiness rather than the stale opening row",async next=>{
    const {user,fresh,release}=await afterReadiness();
    await user.click(screen.getByRole("button",{name:next==="offer"?"Log offer":"Log attempt"}));
    expect(screen.getByText("Loading current lead…")).toBeVisible();
    expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1);
    await act(async()=>release({ok:true,snapshot:fresh,kpis}));
    if(next==="offer"){
      expect(screen.queryByLabelText("Motivation")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Temperature (optional)")).toHaveValue("warm");
      await user.type(screen.getByLabelText("Offer amount"),"125000.50");await user.selectOptions(screen.getByLabelText("Offer method"),"verbal");
      fireEvent.change(screen.getByLabelText("Offer sent"),{target:{value:"2026-09-11T10:00"}});fireEvent.change(screen.getByLabelText("Required follow-up"),{target:{value:"2026-09-12T10:00"}});
    }else{
      await user.selectOptions(screen.getByLabelText("External outcome"),"no_answer");await user.type(screen.getByLabelText("Acquisitions manager"),"Jordan");await user.selectOptions(screen.getByLabelText("Curated follow-up template"),"no-answer-callback-time");fireEvent.change(screen.getByLabelText("When did the outreach occur?"),{target:{value:"2026-09-11T11:00"}});
    }
    mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:fresh,kpis});
    await user.click(screen.getByRole("button",{name:next==="offer"?"Save offer":"Save attempt"}));
    await waitFor(()=>expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2), settle);
    expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toMatchObject({propertyId:"property-1",expectedEpisodeId:"episode-1",expectedQueueVersion:2,expectedSharedStatus:"interested"});
  }, 15_000);
  it.each(["cancel","search","episode","start call"])("does not open from a delayed read after %s changes",async mode=>{
    const {user,fresh,release}=await afterReadiness();await user.click(screen.getByRole("button",{name:"Log offer"}));
    if(mode==="cancel")await user.click(screen.getByRole("button",{name:"Cancel opening"}));
    if(mode==="start call")await user.click(screen.getByRole("button",{name:"Start call"}));
    if(mode==="search")fireEvent.change(screen.getByLabelText("Search My Leads"), { target: { value: "other" } });
    if(mode==="episode")fresh.stages.not_contacted!.rows[0].assignmentEpisodeId="episode-other";
    await act(async()=>release({ok:true,snapshot:fresh,kpis}));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1);
    if(mode==="episode")expect(screen.getByText(/assignment changed/)).toBeVisible();
  }, 15_000);
  it("cancels an old linked opening when a different linked target arrives", async () => {
    const user = userEvent.setup();
    const snapshotA = snapshot("A Deferred Lane");
    const leadA = snapshotA.stages.not_contacted!.rows[0];
    const leadB = { ...leadA, propertyId: "property-b", address: "B Deferred Lane" };
    const snapshotB = { ...snapshotA, stages: { ...snapshotA.stages, not_contacted: { ...snapshotA.stages.not_contacted!, rows: [leadB] } } };
    let release!: (value: unknown) => void;
    mocks.loadMyLeadRow.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const view = render(
      <MyLeadsClient viewer={viewer} roster={roster} initialMemberId="rep-1" initialSnapshot={snapshotA} initialKpis={kpis}
        focus={{ propertyId: leadA.propertyId, memberId: "rep-1", notice: null, pin: leadA }} />,
    );
    await user.click(screen.getByRole("button", { name: "Ready for offer" }));
    expect(screen.getByText("Loading current lead…")).toBeVisible();
    view.rerender(
      <MyLeadsClient viewer={viewer} roster={roster} initialMemberId="rep-1" initialSnapshot={snapshotB} initialKpis={kpis}
        focus={{ propertyId: leadB.propertyId, memberId: "rep-1", notice: null, pin: leadB }} />,
    );
    await act(async () => release({ ok: true, lookup: { status: "found", row: leadA, snapshotAt: snapshotA.snapshotAt } }));
    expect(screen.queryByRole("dialog", { name: "Ready to make an offer" })).not.toBeInTheDocument();
    mocks.loadMyLeadRow.mockResolvedValue({ ok: true, lookup: { status: "found", row: leadB, snapshotAt: snapshotB.snapshotAt } });
    await user.click(screen.getByRole("button", { name: "Ready for offer" }));
    await screen.findByRole("dialog", { name: "Ready to make an offer" });
    expect(screen.queryByText("Loading current lead…")).not.toBeInTheDocument();
    view.unmount();
  });
  it("retries an opening read failure without repeating the saved readiness command",async()=>{
    const {user,fresh,release}=await afterReadiness();await user.click(screen.getByRole("button",{name:"Log offer"}));
    await act(async()=>release({ok:false,message:"Read unavailable"}));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    mocks.loadMyLeadRow.mockResolvedValue({ok:true,lookup:{status:'found',row:fresh.stages.not_contacted!.rows[0],snapshotAt:'x'}});await user.click(screen.getByRole("button",{name:"Retry opening"}));
    expect(await screen.findByRole("dialog", undefined, settle)).toBeVisible();expect(screen.queryByLabelText("Motivation")).not.toBeInTheDocument();expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1);
  }, 15_000);
});


it("keeps elapsed call time advancing when opening a workflow dialog", async () => {
  mocks.loadMyLeadCallReferences.mockResolvedValue({ ok: true, options: [] })
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
  try {
    const clockKpis = { ...kpis, lastAttemptClockVersion: 1, asOf: "2026-09-14T15:00:00Z", lastAttemptAt: "2026-09-14T14:59:00Z" }
    const clockSnapshot = snapshot("Clock Fixture Lane")
    installDefaultRowLookup(clockSnapshot, null)
    const view = render(<MyLeadsClient viewer={viewer} roster={roster} initialMemberId="rep-1" initialSnapshot={clockSnapshot} initialKpis={clockKpis} />)
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByText("1m 5s")).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Log attempt" })) })
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText("1m 5s")).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText("1m 6s")).toBeInTheDocument()
    view.unmount()
  } finally { vi.useRealTimers() }
})
