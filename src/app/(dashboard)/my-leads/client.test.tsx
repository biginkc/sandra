import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"
import { DailyCallClock } from "./_components/daily-call-clock"

const mocks = vi.hoisted(() => ({
  routerRefresh: vi.fn(),
  submitMyLeadCommand: vi.fn(),
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
  submitMyLeadCommand: mocks.submitMyLeadCommand,
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
    onStageAction,
    onReviewingChange,
    kpis: tiles,
  }: {
    onReviewingChange?: (active:boolean)=>void
    kpis: AcquisitionKpis
    stages: { not_contacted?: { rows: Array<{ address: string; propertyId: string }> } }
    search: string
    onStageAction: (kind: string, row: { propertyId: string }) => void
    onSearchChange: (value: string) => void
    canSelectRep: boolean
    selectedRepId: string
    repOptions: Array<{ id: string; label: string }>
    onRepChange: (value: string) => void
  }) => {
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
    mocks.submitMyLeadCommand.mockReset()
    mocks.loadMyLeadCallReferences.mockReset()
  })

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
  mocks.loadMyLeads.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:initial,kpis});
  mocks.loadMyLeadCallReferences.mockResolvedValue({ok:true,options:[]});
  mocks.submitMyLeadCommand.mockResolvedValue({ok:true});
  renderClient(initial);
  await user.click(screen.getByRole("button",{name:"Log attempt"}));
  await user.selectOptions(screen.getByLabelText("External outcome"),"reached");
  fireEvent.change(screen.getByLabelText("When did the outreach occur?"),{target:{value:"2026-09-11T09:00"}});
  await user.click(screen.getByRole("button",{name:"Save attempt"}));
  await waitFor(()=>expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(mocks.loadMyLeads).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button",{name:nextAction==="log-offer"?"Log offer":"Log attempt"}));
  expect(screen.getByText("Loading current lead…")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async()=>{release({ok:true,snapshot:initial,kpis});});
  if(nextAction==="log-offer"){
    await user.type(screen.getByLabelText("Offer amount"),"125000.50");
    await user.selectOptions(screen.getByLabelText("Offer method"),"verbal");
    fireEvent.change(screen.getByLabelText("Offer sent"),{target:{value:"2026-09-11T10:00"}});
    fireEvent.change(screen.getByLabelText("Required follow-up"),{target:{value:"2026-09-12T10:00"}});
    await user.click(screen.getByRole("radio",{name:"No motivation provided"}));
  }else{
    await user.selectOptions(screen.getByLabelText("External outcome"),"no_answer");
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
  async function rejectedDraft(code='STALE_STATE'){
    const user=userEvent.setup();
    mocks.submitMyLeadCommand.mockResolvedValueOnce({ok:false,code,message:'This lead changed. Refresh before trying again.'});
    renderClient(snapshot('106 Fixture Lane'));
    await user.click(screen.getByRole('button',{name:'Log attempt'}));
    await user.selectOptions(screen.getByLabelText('External outcome'),'reached');
    fireEvent.change(screen.getByLabelText('When did the outreach occur?'),{target:{value:'2026-09-11T09:00'}});
    await user.type(screen.getByLabelText('Note (optional)'),'Keep this original draft');
    await user.click(screen.getByRole('button',{name:'Save attempt'}));
    await screen.findByRole('button',{name:'Refresh'});
    expect(screen.getByRole('button',{name:'Save attempt'})).toBeDisabled();
    return user;
  }
  it('refreshes version metadata while preserving the draft and only saves on explicit retry',async()=>{
    const user=await rejectedDraft();
    const fresh=snapshot('106 Fixture Lane');fresh.stages.not_contacted!.rows[0].queueVersion=2;
    mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:fresh,kpis});
    await user.click(screen.getByRole('button',{name:'Refresh'}));
    await screen.findByText('Lead refreshed. Your draft is retained. Review it before saving.');
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('Keep this original draft');
    expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1);
    mocks.submitMyLeadCommand.mockResolvedValueOnce({ok:true});
    await user.click(screen.getByRole('button',{name:'Save attempt'}));
    await waitFor(()=>expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2));
    expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toMatchObject({expectedQueueVersion:2,expectedEpisodeId:'episode-1',note:'Keep this original draft'});
    expect(mocks.submitMyLeadCommand.mock.calls[1][1].idempotencyKey).not.toBe(mocks.submitMyLeadCommand.mock.calls[0][1].idempotencyKey);
  });
  it('ignores recovery finishing after cancellation and reopening the same lead',async()=>{
    const user=await rejectedDraft();
    let release!: (value: unknown)=>void;
    mocks.loadMyLeads.mockReturnValueOnce(new Promise(resolve=>{release=resolve;}));
    await user.click(screen.getByRole('button',{name:'Refresh'}));
    await user.click(screen.getByRole('button',{name:'Cancel'}));
    await user.click(screen.getByRole('button',{name:'Log attempt'}));
    await user.type(screen.getByLabelText('Note (optional)'),'New opening draft');
    const fresh=snapshot('106 Fixture Lane');fresh.stages.not_contacted!.rows[0].queueVersion=99;
    await act(async()=>release({ok:true,snapshot:fresh,kpis}));
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
    mocks.loadMyLeads.mockResolvedValue(kind==='failed read'?{ok:false,message:'denied'}:{ok:true,snapshot:fresh,kpis});
    await user.click(screen.getByRole('button',{name:'Refresh'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh'})).toBeEnabled());
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('Keep this original draft');
    expect(screen.getByRole('button',{name:'Save attempt'})).toBeDisabled();
    expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1);
  });
});


describe("current metadata for rapid workflow openings",()=>{
  beforeEach(()=>{vi.resetAllMocks();mocks.loadMyLeadCallReferences.mockResolvedValue({ok:true,options:[]});});
  async function afterReadiness(){
    const user=userEvent.setup();const initial=snapshot("106 Fixture Lane");
    let release!:(value:unknown)=>void;
    mocks.loadMyLeads.mockReturnValueOnce(new Promise(resolve=>{release=resolve;}));
    mocks.submitMyLeadCommand.mockResolvedValue({ok:true});
    renderClient(initial);
    await user.click(screen.getByRole("button",{name:"Ready for offer"}));
    await user.type(screen.getByLabelText("Motivation"),"Seller plans to relocate.");
    await user.selectOptions(screen.getByLabelText("Temperature (optional)"),"warm");
    await user.click(screen.getByRole("button",{name:"Save readiness"}));
    await waitFor(()=>expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const fresh=snapshot("106 Fixture Lane");Object.assign(fresh.stages.not_contacted!.rows[0],{queueVersion:2,sharedStatus:"interested",motivationKind:"specified",motivationText:"Seller plans to relocate.",temperature:"warm"});
    return {user,initial,fresh,release};
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
      await user.selectOptions(screen.getByLabelText("External outcome"),"no_answer");fireEvent.change(screen.getByLabelText("When did the outreach occur?"),{target:{value:"2026-09-11T11:00"}});
    }
    mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:fresh,kpis});
    await user.click(screen.getByRole("button",{name:next==="offer"?"Save offer":"Save attempt"}));
    await waitFor(()=>expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2));
    expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toMatchObject({propertyId:"property-1",expectedEpisodeId:"episode-1",expectedQueueVersion:2,expectedSharedStatus:"interested"});
  });
  it.each(["cancel","search","episode","start call"])("does not open from a delayed read after %s changes",async mode=>{
    const {user,fresh,release}=await afterReadiness();await user.click(screen.getByRole("button",{name:"Log offer"}));
    if(mode==="cancel")await user.click(screen.getByRole("button",{name:"Cancel opening"}));
    if(mode==="start call")await user.click(screen.getByRole("button",{name:"Start call"}));
    if(mode==="search")await user.type(screen.getByLabelText("Search My Leads"),"other");
    if(mode==="episode")fresh.stages.not_contacted!.rows[0].assignmentEpisodeId="episode-other";
    await act(async()=>release({ok:true,snapshot:fresh,kpis}));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1);
    if(mode==="episode")expect(screen.getByText(/assignment changed/)).toBeVisible();
  });
  it.each(["foreground","background"])("a later authorized %s queue refresh replaces a failed barrier for future openings",async mode=>{
    const {user,fresh,release}=await afterReadiness();
    await act(async()=>release({ok:false,message:"First read failed"}));
    mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:fresh,kpis});
    if(mode==="background"){await user.click(screen.getByRole("button",{name:"Expand details"}));await act(async()=>window.dispatchEvent(new Event("focus")));}
    else await user.click(screen.getByRole("button",{name:"Retry now"}));
    await waitFor(()=>expect(screen.queryByText(/Displayed counts may be out of date/)).not.toBeInTheDocument());
    await user.click(screen.getByRole("button",{name:"Log offer"}));
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(screen.queryByText(/Could not load current lead details/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Motivation")).not.toBeInTheDocument();
    expect(mocks.loadMyLeads).toHaveBeenCalledTimes(2);
    expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1);
  });
  it("retries an opening read failure without repeating the saved readiness command",async()=>{
    const {user,fresh,release}=await afterReadiness();await user.click(screen.getByRole("button",{name:"Log offer"}));
    await act(async()=>release({ok:false,message:"Read unavailable"}));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:fresh,kpis});await user.click(screen.getByRole("button",{name:"Retry opening"}));
    expect(await screen.findByRole("dialog")).toBeVisible();expect(screen.queryByLabelText("Motivation")).not.toBeInTheDocument();expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1);
  });
});


it("keeps elapsed call time advancing when opening a workflow dialog", () => {
  mocks.loadMyLeadCallReferences.mockResolvedValue({ ok: true, options: [] })
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
  try {
    const clockKpis = { ...kpis, lastAttemptClockVersion: 1, asOf: "2026-09-14T15:00:00Z", lastAttemptAt: "2026-09-14T14:59:00Z" }
    const view = render(<MyLeadsClient viewer={viewer} roster={roster} initialMemberId="rep-1" initialSnapshot={snapshot("Clock Fixture Lane")} initialKpis={clockKpis} />)
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByText("1m 5s")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Log attempt" }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText("1m 5s")).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText("1m 6s")).toBeInTheDocument()
    view.unmount()
  } finally { vi.useRealTimers() }
})
