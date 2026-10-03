import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"
import { DailyCallClock } from "./_components/daily-call-clock"

const mocks = vi.hoisted(() => ({
  routerRefresh: vi.fn(),
  submitMyLeadCommand: vi.fn(),
  submitMyLeadHandoffDrip: vi.fn(),
  loadMyLeads: vi.fn(),
  loadMyLeadDetail: vi.fn(),
  loadMyLeadQueueRow: vi.fn(),
  loadMyLeadCallReferences: vi.fn(),
  realDialpad: false,
  realQueue: false,
  dialpadTargets: vi.fn(),
  dialpadRecent: vi.fn(),
  dialpadHandlers: [] as Array<((nonce: number) => void) | undefined>,
  dialpadLogOutcome: undefined as ((propertyId: string, callActivityId: string) => void) | undefined,
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
  loadMyLeadsStage: vi.fn(),
  loadMyLeadDetail: mocks.loadMyLeadDetail,
  loadMyLeadQueueRow: mocks.loadMyLeadQueueRow,
  loadMyLeadCallReferences: mocks.loadMyLeadCallReferences,
  submitMyLeadCommand: mocks.submitMyLeadCommand,
  submitMyLeadHandoffDrip: mocks.submitMyLeadHandoffDrip,
  changeAcquisitionDesignation: vi.fn(),
  changeAcquisitionSettings: vi.fn(),
}))

vi.mock("@/app/(dashboard)/sequences/actions", () => ({
  listDripChoices: mocks.listDripChoices,
  startDripForLeads: vi.fn(),
}))

vi.mock("./_components/existing-detail-actions", () => ({
  MyLeadAppointmentActions: ({ onChanged }: { onChanged?: () => void }) => (
    <button type="button" onClick={() => onChanged?.()}>Update linked detail</button>
  ),
  MyLeadCallbackActions: ({ onChanged }: { onChanged?: () => void }) => (
    <button type="button" onClick={() => onChanged?.()}>Update linked callback</button>
  ),
}))

vi.mock("./dialpad-actions", () => ({
  verifyDialpadBindingAction: vi.fn(), listDialpadCallTargetsAction: mocks.dialpadTargets,
  startDialpadCallAction: vi.fn(), getDialpadCallStatusAction: vi.fn(),
  cancelDialpadCallAction: vi.fn(), listRecentDialpadCallsAction: mocks.dialpadRecent,
}))
vi.mock("./dialpad-recording-actions", () => ({
  closeDialpadRecordingCaptureAction: vi.fn(), getDialpadRecordingBrowserStatusAction: vi.fn(),
  mintDialpadRecordingNextEpochAction: vi.fn(), openDialpadRecordingCaptureAction: vi.fn(),
}))
vi.mock("./_components/dialpad-panel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_components/dialpad-panel")>()
  return { DialpadPanel: (props: React.ComponentProps<typeof actual.DialpadPanel>) => {
    if (mocks.realDialpad) return React.createElement(actual.DialpadPanel, props)
    mocks.dialpadHandlers.push(props.onCallRequestHandled)
    mocks.dialpadLogOutcome = props.onLogOutcome
    return React.createElement(React.Fragment, null,
      React.createElement("button", { type: "button", "data-testid": "dialpad-panel-stub", onClick: () => props.onCallRequestHandled?.(1) }, "Dialpad panel"),
      React.createElement("button", { type: "button", "data-testid": "dialpad-log-outcome", onClick: () => props.onLogOutcome("outside-page", "activity-1") }, "Log Dialpad outcome"),
    )
  }}
})

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



import type { AcquisitionKpis, AcquisitionRoster, QueueRow, QueueSnapshot } from "@/lib/my-leads/queries"
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

function renderClient(initialSnapshot: QueueSnapshot, initialKpis = kpis, initialDrips:MyLeadDripSnapshot|null=null, dialpad?: React.ComponentProps<typeof MyLeadsClient>["dialpad"], selectedLead?: React.ComponentProps<typeof MyLeadsClient>["selectedLead"]) {
  return render(
    <MyLeadsClient
      viewer={viewer}
      roster={roster}
      initialMemberId={viewer.userId}
      initialSnapshot={initialSnapshot}
      initialKpis={initialKpis}
      initialDrips={initialDrips}
      dialpad={dialpad}
      selectedLead={selectedLead}
    />,
  )
}

function linkedRow(stage: QueueRow["stage"] = "contacted"): QueueRow {
  const row = snapshot("Outside page Lane").stages.not_contacted!.rows[0];
  return { ...row, propertyId: "outside-page", stage, address: "Outside page Lane" };
}

describe("MyLeadsClient", () => {
  beforeEach(() => {
    mocks.loadMyLeads.mockReset()
    mocks.loadMyLeadDetail.mockReset()
    mocks.loadMyLeadQueueRow.mockReset()
    mocks.submitMyLeadCommand.mockReset()
    mocks.loadMyLeadCallReferences.mockReset()
    mocks.dialpadHandlers.length = 0
    mocks.dialpadLogOutcome = undefined
    mocks.realDialpad = false
    mocks.realQueue = false
    mocks.dialpadRecent.mockResolvedValue({ok:true,calls:[]})
    mocks.dialpadTargets.mockResolvedValue({ok:true,contactId:'contact-1',phones:[{slot:1,masked:'••• ••• 0196'}],grants:[]})
  })

  it("opens the exact authorized lead outside the active filter and does not follow an owner queue switch", async () => {
    const own = snapshot("Deep Link Lane")
    const row = {...own.stages.not_contacted!.rows[0], propertyId:"outside-filter", address:"Outside current filter"}
    mocks.loadMyLeadDetail.mockResolvedValue({ok:false, message:"This lead is unavailable in your My Leads queue."})
    mocks.loadMyLeads.mockResolvedValue({ok:true, snapshot:own, kpis})
    const ownerViewer = {...viewer, isOwner:true}
    const ownerRoster: AcquisitionRoster = {
      ...roster,
      isOwner:true,
      members:[...roster.members, {...roster.members[0], id:"rep-2", label:"Other rep"}],
    }
    render(<MyLeadsClient
      viewer={ownerViewer}
      roster={ownerRoster}
      initialMemberId={ownerViewer.userId}
      initialSnapshot={own}
      initialKpis={kpis}
      selectedLead={{status:"found", propertyId:row.propertyId, row, snapshotAt:own.snapshotAt}}
    />)

    expect(await screen.findByRole("region", {name:"Selected lead from link"})).toBeInTheDocument()
    expect(mocks.loadMyLeadDetail).toHaveBeenCalledWith({memberId:"rep-1", propertyId:row.propertyId})
    await userEvent.type(screen.getByRole("textbox", {name:"Search My Leads"}), "outside current filter")
    expect(screen.getByRole("region", {name:"Selected lead from link"})).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByRole("combobox", {name:"Acquisitions member"}), "rep-2")
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Switch back to your queue"))
  })

  it("reconciles server-selected lead changes and authoritative unavailable results", async () => {
    const initial = snapshot("Server selection lane")
    const first = linkedRow("contacted")
    const second = { ...first, propertyId: "second-linked", address: "Second linked lane" }
    mocks.loadMyLeadDetail.mockResolvedValue({ ok: true, detail: { groups: {} } })
    const view = renderClient(initial, kpis, null, undefined, {
      status: "found",
      propertyId: first.propertyId,
      row: first,
      snapshotAt: initial.snapshotAt,
    })

    expect(await screen.findByRole("region", { name: "Selected lead from link" })).toHaveTextContent("Outside page Lane")
    view.rerender(<MyLeadsClient viewer={viewer} roster={roster} initialMemberId={viewer.userId} initialSnapshot={initial} initialKpis={kpis} selectedLead={{ status: "found", propertyId: second.propertyId, row: second, snapshotAt: initial.snapshotAt }} />)
    await waitFor(() => expect(screen.getByRole("region", { name: "Selected lead from link" })).toHaveTextContent("Second linked lane"))

    view.rerender(<MyLeadsClient viewer={viewer} roster={roster} initialMemberId={viewer.userId} initialSnapshot={initial} initialKpis={kpis} selectedLead={{ status: "unavailable", message: "The server no longer authorizes this lead." }} />)
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The server no longer authorizes this lead."))
    expect(screen.queryByRole("region", { name: "Selected lead from link" })).not.toBeInTheDocument()
  })

  it("preserves same-lead details while reconciling an updated server row", async () => {
    const initial = snapshot("Same lead lane")
    const first = linkedRow("contacted")
    const updated = { ...first, address: "Same lead refreshed", queueVersion: first.queueVersion + 1 }
    mocks.loadMyLeadDetail.mockResolvedValue({
      ok: true,
      detail: { groups: { notes: { rows: [{ id: "note-1", actorLabel: "Maria", body: "Preserve this detail", at: "2026-09-11T14:00:00Z" }] } } },
    })
    const view = renderClient(initial, kpis, null, undefined, {
      status: "found",
      propertyId: first.propertyId,
      row: first,
      snapshotAt: initial.snapshotAt,
    })
    expect(await screen.findByText("Preserve this detail")).toBeInTheDocument()

    view.rerender(<MyLeadsClient viewer={viewer} roster={roster} initialMemberId={viewer.userId} initialSnapshot={initial} initialKpis={kpis} selectedLead={{ status: "found", propertyId: first.propertyId, row: updated, snapshotAt: "2026-09-11T14:01:00.000Z" }} />)
    await waitFor(() => expect(screen.getByRole("region", { name: "Selected lead from link" })).toHaveTextContent("Same lead refreshed"))
    expect(screen.getByText("Preserve this detail")).toBeInTheDocument()
    expect(mocks.loadMyLeadDetail).toHaveBeenCalledTimes(1)
  })

  it("drops the previous lead details immediately while a new linked lead loads", async () => {
    const initial = snapshot("Lead switch lane")
    const first = linkedRow("contacted")
    const second = { ...first, propertyId: "second-linked", address: "Second linked lane" }
    let resolveSecond!: (value: unknown) => void
    const detail = (body: string) => ({ ok: true, detail: { groups: { notes: { rows: [{ id: body, actorLabel: "Maria", body, at: "2026-09-11T14:00:00Z" }] } } } })
    mocks.loadMyLeadDetail
      .mockResolvedValueOnce(detail("First lead detail"))
      .mockReturnValueOnce(new Promise(resolve => { resolveSecond = resolve }))
    const view = renderClient(initial, kpis, null, undefined, {
      status: "found",
      propertyId: first.propertyId,
      row: first,
      snapshotAt: initial.snapshotAt,
    })
    expect(await screen.findByText("First lead detail")).toBeInTheDocument()

    view.rerender(<MyLeadsClient viewer={viewer} roster={roster} initialMemberId={viewer.userId} initialSnapshot={initial} initialKpis={kpis} selectedLead={{ status: "found", propertyId: second.propertyId, row: second, snapshotAt: initial.snapshotAt }} />)
    await waitFor(() => expect(screen.getByRole("region", { name: "Selected lead from link" })).toHaveTextContent("Second linked lane"))
    expect(screen.queryByText("First lead detail")).not.toBeInTheDocument()
    expect(screen.getByText("Loading details…")).toBeInTheDocument()

    await act(async () => resolveSecond(detail("Second lead detail")))
    expect(await screen.findByText("Second lead detail")).toBeInTheDocument()
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

  it("opens Dialpad Log outcome for a linked lead outside the loaded queue", async () => {
    const user = userEvent.setup();
    const initial = snapshot("Loaded queue lane");
    const first = linkedRow("contacted");
    mocks.loadMyLeadDetail.mockResolvedValue({ ok: true, detail: { groups: {} } });
    mocks.loadMyLeadQueueRow.mockResolvedValue({
      ok: true,
      lookup: { status: "found", row: first, snapshotAt: initial.snapshotAt },
    });
    mocks.loadMyLeadCallReferences.mockResolvedValue({ ok: true, options: [] });

    renderClient(initial, kpis, null, {
      connectionId: "connection-1",
      allowedOrigins: ["https://dialpad.com"],
      binding: { status: "verified", dialpadUserId: "5551234" },
      grants: [],
    }, {
      status: "found",
      propertyId: first.propertyId,
      row: first,
      snapshotAt: initial.snapshotAt,
    });

    await user.click(screen.getByTestId("dialpad-log-outcome"));
    expect(await screen.findByRole("dialog", { name: /Log an attempt/i })).toBeVisible();
    expect(mocks.loadMyLeadQueueRow).toHaveBeenCalledWith({ memberId: "rep-1", propertyId: "outside-page" });
    expect(mocks.loadMyLeadCallReferences).toHaveBeenCalledWith("outside-page", "rep-1");
  });

  it("refreshes a linked lead by id after save before opening its second action", async () => {
    const user = userEvent.setup();
    const initial = snapshot("Loaded queue lane");
    const first = linkedRow("contacted");
    const saved = { ...first, queueVersion: 2, sharedStatus: "interested" };
    mocks.loadMyLeadDetail.mockResolvedValue({ ok: true, detail: { groups: {} } });
    mocks.loadMyLeadQueueRow
      .mockResolvedValueOnce({ ok: true, lookup: { status: "found", row: first, snapshotAt: initial.snapshotAt } })
      .mockResolvedValueOnce({ ok: true, lookup: { status: "found", row: saved, snapshotAt: "2026-09-11T14:01:00.000Z" } })
      .mockResolvedValueOnce({ ok: true, lookup: { status: "found", row: saved, snapshotAt: "2026-09-11T14:01:00.000Z" } });
    mocks.submitMyLeadCommand.mockResolvedValue({ ok: true });

    renderClient(initial, kpis, null, undefined, {
      status: "found",
      propertyId: first.propertyId,
      row: first,
      snapshotAt: initial.snapshotAt,
    });
    const region = await screen.findByRole("region", { name: "Selected lead from link" });
    await user.click(within(region).getByRole("button", { name: "Ready to make an offer" }));
    fireEvent.change(screen.getByLabelText("Motivation"), { target: { value: "Seller plans to relocate." } });
    await user.selectOptions(screen.getByLabelText("Temperature (optional)"), "warm");
    await user.click(screen.getByRole("button", { name: "Save readiness" }));
    await waitFor(() => expect(mocks.loadMyLeadQueueRow).toHaveBeenCalledTimes(2));

    const updatedRegion = screen.getByRole("region", { name: "Selected lead from link" });
    await user.click(within(updatedRegion).getByRole("button", { name: "Log offer" }));
    await waitFor(() => expect(mocks.loadMyLeadQueueRow).toHaveBeenCalledTimes(3));
    await user.type(screen.getByLabelText("Offer amount"), "125000.50");
    await user.selectOptions(screen.getByLabelText("Offer method"), "verbal");
    fireEvent.change(screen.getByLabelText("Offer sent"), { target: { value: "2026-09-11T10:00" } });
    fireEvent.change(screen.getByLabelText("Required follow-up"), { target: { value: "2026-09-12T10:00" } });
    await user.click(screen.getByRole("radio", { name: "No motivation provided" }));
    await user.click(screen.getByRole("button", { name: "Save offer" }));

    await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2));
    expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toMatchObject({
      propertyId: "outside-page",
      expectedQueueVersion: 2,
    });
  });

  it("refreshes the normal queue and KPIs when a linked lead is also in that queue", async () => {
    const user = userEvent.setup();
    const initial = snapshot("Linked queue lane");
    const first = { ...initial.stages.not_contacted!.rows[0], stage: "contacted" as const };
    const saved = { ...first, queueVersion: 2, sharedStatus: "interested", attemptsCount: 1 };
    const refreshed = {
      ...initial,
      stages: {
        ...initial.stages,
        not_contacted: { ...initial.stages.not_contacted!, rows: [{ ...saved, address: "Linked queue refreshed" }] },
      },
    };
    mocks.loadMyLeadDetail.mockResolvedValue({ ok: true, detail: { groups: {} } });
    mocks.loadMyLeadQueueRow
      .mockResolvedValueOnce({ ok: true, lookup: { status: "found", row: first, snapshotAt: initial.snapshotAt } })
      .mockResolvedValueOnce({ ok: true, lookup: { status: "found", row: saved, snapshotAt: "2026-09-11T14:01:00.000Z" } });
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: refreshed, kpis: { ...kpis, attempts: 2 } });
    mocks.submitMyLeadCommand.mockResolvedValue({ ok: true });

    renderClient(initial, kpis, null, undefined, {
      status: "found",
      propertyId: first.propertyId,
      row: first,
      snapshotAt: initial.snapshotAt,
    });
    const region = await screen.findByRole("region", { name: "Selected lead from link" });
    await user.click(within(region).getByRole("button", { name: "Ready to make an offer" }));
    fireEvent.change(screen.getByLabelText("Motivation"), { target: { value: "Seller plans to relocate." } });
    await user.selectOptions(screen.getByLabelText("Temperature (optional)"), "warm");
    await user.click(screen.getByRole("button", { name: "Save readiness" }));

    await waitFor(() => expect(mocks.loadMyLeads).toHaveBeenCalledWith({ memberId: "rep-1", search: "", period: "today" }));
    expect(screen.getByTestId("attempt-count")).toHaveTextContent("2");
    expect(screen.getByTestId("queue-address")).toHaveTextContent("Linked queue refreshed");
  });

  it("keeps a linked lead active when a drip handoff retains its owner", async () => {
    const user = userEvent.setup();
    const initial = snapshot("Drip handoff lane");
    const first = linkedRow("contacted");
    const saved = { ...first, queueVersion: 2, sharedStatus: "needs_drip", address: "Drip handoff refreshed" };
    mocks.loadMyLeadDetail.mockResolvedValue({ ok: true, detail: { groups: {} } });
    mocks.loadMyLeadQueueRow
      .mockResolvedValueOnce({ ok: true, lookup: { status: "found", row: first, snapshotAt: initial.snapshotAt } })
      .mockResolvedValueOnce({ ok: true, lookup: { status: "found", row: saved, snapshotAt: "2026-09-11T14:01:00.000Z" } });
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: initial, kpis });
    mocks.submitMyLeadHandoffDrip.mockResolvedValue({ ok: true });

    renderClient(initial, kpis, null, undefined, {
      status: "found",
      propertyId: first.propertyId,
      row: first,
      snapshotAt: initial.snapshotAt,
    });
    const region = await screen.findByRole("region", { name: "Selected lead from link" });
    await user.click(within(region).getByRole("button", { name: "Handoff" }));
    await user.selectOptions(screen.getByLabelText("Handoff reason"), "not_interested");
    await user.click(await screen.findByRole("button", { name: /Seller follow-up/ }));
    await user.click(screen.getByRole("button", { name: "Hand off lead" }));

    await waitFor(() => expect(mocks.submitMyLeadHandoffDrip).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.loadMyLeadQueueRow).toHaveBeenCalledTimes(2));
    const updatedRegion = screen.getByRole("region", { name: "Selected lead from link" });
    expect(updatedRegion).toHaveTextContent("Drip handoff refreshed");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a neutral terminal state when a linked lead is actually archived", async () => {
    const user = userEvent.setup();
    const initial = snapshot("Archive lane");
    const first = linkedRow("under_contract");
    mocks.loadMyLeadDetail.mockResolvedValue({ ok: true, detail: { groups: {} } });
    mocks.loadMyLeadQueueRow
      .mockResolvedValueOnce({ ok: true, lookup: { status: "found", row: first, snapshotAt: initial.snapshotAt } })
      .mockResolvedValueOnce({ ok: true, lookup: { status: "unavailable", reason: "archived" } });
    mocks.submitMyLeadCommand.mockResolvedValue({ ok: true });

    renderClient(initial, kpis, null, undefined, {
      status: "found",
      propertyId: first.propertyId,
      row: first,
      snapshotAt: initial.snapshotAt,
    });
    const region = await screen.findByRole("region", { name: "Selected lead from link" });
    await user.click(within(region).getByRole("button", { name: "Archive" }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Archive lead" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("archived"));
    expect(screen.queryByRole("region", { name: "Selected lead from link" })).not.toBeInTheDocument();
  });

  it("retains linked details while newer detail reads win over stale responses", async () => {
    const initial = snapshot("Detail race lane");
    const first = linkedRow("contacted");
    let resolveSecond!: (value: unknown) => void;
    let resolveThird!: (value: unknown) => void;
    const detail = (body: string) => ({ ok: true, detail: { groups: { notes: { rows: [{ id: body, actorLabel: "Maria", body, at: "2026-09-11T14:00:00.000Z" }], cursor: null, hasMore: false } } } });
    mocks.loadMyLeadDetail
      .mockResolvedValueOnce(detail("old detail"))
      .mockReturnValueOnce(new Promise(resolve => { resolveSecond = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveThird = resolve; }));

    const view = renderClient(initial, kpis, null, undefined, {
      status: "found",
      propertyId: first.propertyId,
      row: first,
      snapshotAt: initial.snapshotAt,
    });
    expect(await screen.findByText("old detail")).toBeInTheDocument();

    const changedRoster = { ...roster, members: [...roster.members] };
    view.rerender(<MyLeadsClient viewer={viewer} roster={changedRoster} initialMemberId={viewer.userId} initialSnapshot={initial} initialKpis={kpis} selectedLead={{ status: "found", propertyId: first.propertyId, row: first, snapshotAt: initial.snapshotAt }} />);
    await waitFor(() => expect(screen.queryByText("Loading details…")).not.toBeInTheDocument());
    view.rerender(<MyLeadsClient viewer={viewer} roster={{ ...changedRoster, settings: { ...changedRoster.settings } }} initialMemberId={viewer.userId} initialSnapshot={initial} initialKpis={kpis} selectedLead={{ status: "found", propertyId: first.propertyId, row: first, snapshotAt: initial.snapshotAt }} />);
    await act(async () => resolveThird(detail("new detail")));
    await act(async () => resolveSecond(detail("stale detail")));

    expect(screen.getByText("new detail")).toBeInTheDocument();
    expect(screen.queryByText("stale detail")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading details…")).not.toBeInTheDocument();
  });

  it("opens from its own read when a newer linked refresh wins the card", async () => {
    const user = userEvent.setup();
    const initial = snapshot("Linked overlap lane");
    const first = linkedRow("contacted");
    const older = { ...first, address: "Older linked lane", queueVersion: 2 };
    const newer = { ...first, address: "Current linked lane", queueVersion: 3 };
    let resolveOlder!: (value: unknown) => void;
    let resolveNewer!: (value: unknown) => void;
    mocks.loadMyLeadDetail.mockResolvedValue({
      ok: true,
      detail: {
        groups: {
          appointments: {
            rows: [{ id: "appointment-1", type: "appointment", currentAssigneeId: "rep-1", lifecycleState: "scheduled", title: "Inspection", at: "2026-09-11T14:00:00Z" }],
          },
        },
      },
    });
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: initial, kpis });
    mocks.loadMyLeadQueueRow
      .mockReturnValueOnce(new Promise(resolve => { resolveOlder = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveNewer = resolve; }));

    renderClient(initial, kpis, null, undefined, {
      status: "found",
      propertyId: first.propertyId,
      row: first,
      snapshotAt: initial.snapshotAt,
    });
    const region = await screen.findByRole("region", { name: "Selected lead from link" });
    await user.click(within(region).getByRole("button", { name: "Ready to make an offer" }));
    expect(screen.getByText("Loading current lead…")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Update linked detail" }));
    await waitFor(() => expect(mocks.loadMyLeadQueueRow).toHaveBeenCalledTimes(2));

    await act(async () => resolveOlder({ ok: true, lookup: { status: "found", row: older, snapshotAt: "2026-09-11T14:01:00.000Z" } }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    await act(async () => resolveNewer({ ok: true, lookup: { status: "found", row: newer, snapshotAt: "2026-09-11T14:02:00.000Z" } }));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Selected lead from link" })).toHaveTextContent("Current linked lane"));
    expect(screen.queryByText("This lead is unavailable or its assignment changed.")).not.toBeInTheDocument();
  });

  it("uses the linked single-row read for stale recovery outside the loaded queue", async () => {
    const user = userEvent.setup();
    const initial = snapshot("Loaded queue lane");
    const first = linkedRow("contacted");
    const fresh = { ...first, queueVersion: 2, sharedStatus: "interested" };
    mocks.loadMyLeadDetail.mockResolvedValue({ ok: true, detail: { groups: {} } });
    mocks.loadMyLeadQueueRow
      .mockResolvedValueOnce({ ok: true, lookup: { status: "found", row: first, snapshotAt: initial.snapshotAt } })
      .mockResolvedValueOnce({ ok: true, lookup: { status: "found", row: fresh, snapshotAt: "2026-09-11T14:02:00.000Z" } });
    mocks.submitMyLeadCommand
      .mockResolvedValueOnce({ ok: false, code: "STALE_STATE", message: "This lead changed. Refresh before trying again." })
      .mockResolvedValueOnce({ ok: true });

    renderClient(initial, kpis, null, undefined, {
      status: "found",
      propertyId: first.propertyId,
      row: first,
      snapshotAt: initial.snapshotAt,
    });
    const region = await screen.findByRole("region", { name: "Selected lead from link" });
    await user.click(within(region).getByRole("button", { name: "Ready to make an offer" }));
    fireEvent.change(screen.getByLabelText("Motivation"), { target: { value: "Seller plans to relocate." } });
    await user.selectOptions(screen.getByLabelText("Temperature (optional)"), "warm");
    await user.click(screen.getByRole("button", { name: "Save readiness" }));
    await screen.findByRole("button", { name: "Refresh" });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Lead refreshed. Your draft is retained. Review it before saving.");
    await user.click(screen.getByRole("button", { name: "Save readiness" }));
    await waitFor(() => expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2));
    expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toMatchObject({
      propertyId: "outside-page",
      expectedQueueVersion: 2,
    });
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

  it("keeps the real Dialpad chooser visible after the parent consumes a completed lookup", async () => {
    mocks.realDialpad = true
    const initial = snapshot("1842 Lantern Finch Lane")
    mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:initial,kpis})
    const view = renderClient(initial,kpis,null,{
      connectionId:"connection-1",allowedOrigins:["https://dialpad.com"],
      binding:{status:"verified",dialpadUserId:"5551234"},grants:[],
    })
    const iframe = view.container.querySelector('iframe')!
    act(() => window.dispatchEvent(new MessageEvent('message', {origin:'https://dialpad.com',source:iframe.contentWindow,
      data:{api:'opencti_dialpad',version:'1.0',method:'user_authentication',payload:{user_authenticated:true,user_id:5551234}}})))
    await userEvent.click(screen.getByRole('button',{name:'Start call'}))
    await waitFor(()=>expect(mocks.dialpadTargets).toHaveBeenCalledWith({propertyId:'property-1',contactId:'contact-1'}))
    await waitFor(()=>expect(screen.getByRole('button',{name:'Call'})).toBeEnabled())
    expect(screen.getByRole('radio',{name:/0196/})).toBeInTheDocument()
    view.unmount()
  })

  it("opens the real chooser after switching to the own queue and filtering an expanded lead", async () => {
    mocks.realDialpad = true
    const own = snapshot("1842 Lantern Finch Lane")
    const other = snapshot("Other Lane")
    other.stages.not_contacted!.rows[0].propertyId = 'other-property'
    mocks.loadMyLeads.mockImplementation(async ({memberId}) => ({ok:true,snapshot:memberId==='rep-1'?own:other,kpis}))
    const view = render(<MyLeadsClient viewer={{...viewer,isOwner:true}}
      roster={{...roster,isOwner:true,members:[...roster.members,{...roster.members[0],id:'rep-2',label:'Other rep'}]}}
      initialMemberId="rep-2" initialSnapshot={other} initialKpis={kpis}
      dialpad={{connectionId:'c1',allowedOrigins:['https://dialpad.com'],binding:{status:'verified',dialpadUserId:'5551234'},grants:[]}} />)
    const iframe=view.container.querySelector('iframe')!
    act(()=>window.dispatchEvent(new MessageEvent('message',{origin:'https://dialpad.com',source:iframe.contentWindow,
      data:{api:'opencti_dialpad',version:'1.0',method:'user_authentication',payload:{user_authenticated:true,user_id:5551234}}})))
    await userEvent.selectOptions(screen.getByRole('combobox',{name:'Acquisitions member'}),'rep-1')
    await waitFor(()=>expect(screen.getByTestId('queue-address')).toHaveTextContent('1842 Lantern Finch Lane'))
    await userEvent.type(screen.getByRole('textbox',{name:'Search My Leads'}),'1842 Lantern Finch')
    await waitFor(()=>expect(mocks.loadMyLeads).toHaveBeenLastCalledWith({memberId:'rep-1',search:'1842 Lantern Finch',period:'today'}))
    await userEvent.click(screen.getByRole('button',{name:'Expand details'}))
    await userEvent.click(screen.getByRole('button',{name:'Start call'}))
    await waitFor(()=>expect(screen.getByRole('button',{name:'Call'})).toBeEnabled())
    expect(mocks.dialpadTargets).toHaveBeenCalledWith({propertyId:'property-1',contactId:'contact-1'})
    view.unmount()
  })

  it("opens the chooser through the actual queue row after member selection and filtering", async () => {
    mocks.realDialpad = true
    mocks.realQueue = true
    const own = snapshot("1842 Lantern Finch Lane")
    const other = snapshot("Other Lane")
    other.stages.not_contacted!.rows[0].propertyId = 'other-property'
    mocks.loadMyLeads.mockImplementation(async ({memberId}) => ({ok:true,snapshot:memberId==='rep-1'?own:other,kpis}))
    const view = render(<MyLeadsClient viewer={{...viewer,isOwner:true}}
      roster={{...roster,isOwner:true,members:[...roster.members,{...roster.members[0],id:'rep-2',label:'Other rep'}]}}
      initialMemberId="rep-2" initialSnapshot={other} initialKpis={kpis}
      dialpad={{connectionId:'c1',allowedOrigins:['https://dialpad.com'],binding:{status:'verified',dialpadUserId:'5551234'},grants:[]}} />)
    const iframe=view.container.querySelector('iframe')!
    act(()=>window.dispatchEvent(new MessageEvent('message',{origin:'https://dialpad.com',source:iframe.contentWindow,
      data:{api:'opencti_dialpad',version:'1.0',method:'user_authentication',payload:{user_authenticated:true,user_id:5551234}}})))
    await userEvent.selectOptions(screen.getByRole('combobox',{name:'Acquisitions member'}),'rep-1')
    await screen.findByRole('button',{name:'Show details for 1842 Lantern Finch Lane'})
    await userEvent.type(screen.getByRole('textbox',{name:'Search My Leads'}),'1842 Lantern Finch')
    await waitFor(()=>expect(mocks.loadMyLeads).toHaveBeenLastCalledWith({memberId:'rep-1',search:'1842 Lantern Finch',period:'today'}))
    await userEvent.click(screen.getByRole('button',{name:'Show details for 1842 Lantern Finch Lane'}))
    await userEvent.click(screen.getByRole('button',{name:'Start call'}))
    await waitFor(()=>expect(screen.getByRole('button',{name:'Call'})).toBeEnabled())
    expect(mocks.dialpadTargets).toHaveBeenCalledWith({propertyId:'property-1',contactId:'contact-1'})
    view.unmount()
  })

  it("keeps the Dialpad request handler stable across focus and 30-second queue refreshes", async () => {
    vi.useFakeTimers()
    const initial = snapshot("106 Fixture Lane")
    mocks.loadMyLeads.mockResolvedValue({ ok: true, snapshot: { ...initial, snapshotAt: "2026-09-11T14:01:00.000Z" }, kpis })
    const dialpad = {
      connectionId: "connection-1",
      allowedOrigins: ["https://dialpad.com"],
      binding: { status: "verified", dialpadUserId: "5551234" },
      grants: [],
    } as React.ComponentProps<typeof MyLeadsClient>["dialpad"]
    const view = renderClient(initial, kpis, null, dialpad)
    try {
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start call" })) })
      expect(screen.getByTestId("dialpad-panel-stub")).toBeInTheDocument()
      const firstHandler = mocks.dialpadHandlers.at(-1)
      expect(firstHandler).toBeDefined()
      await act(async () => { window.dispatchEvent(new Event("focus")) })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(mocks.loadMyLeads).toHaveBeenCalledTimes(2)
      expect(mocks.dialpadHandlers.length).toBeGreaterThan(1)
      expect(mocks.dialpadHandlers.every((handler) => handler === firstHandler)).toBe(true)
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
  mocks.loadMyLeads.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:initial,kpis});
  mocks.loadMyLeadCallReferences.mockResolvedValue({ok:true,options:[]});
  mocks.submitMyLeadCommand.mockResolvedValue({ok:true});
  renderClient(initial);
  await user.click(screen.getByRole("button",{name:"Log attempt"}));
  await user.selectOptions(screen.getByLabelText("External outcome"),"reached");
  fireEvent.change(screen.getByLabelText("When did the outreach occur?"),{target:{value:"2026-09-11T09:00"}});
  await user.click(screen.getByRole("button",{name:"Save attempt"}));
  await user.click(await screen.findByRole('button',{name:'Done without a drip'}));
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
    mocks.submitMyLeadHandoffDrip.mockResolvedValueOnce({ok:false,code:'STALE_STATE',message:'This lead changed. Refresh before trying again.'})
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
    await user.click(screen.getByRole('button',{name:'Refresh'}));
    await screen.findByText('Lead refreshed. Your draft is retained. Review it before saving.');
    expect(screen.getByLabelText('Handoff reason')).toHaveValue('not_interested');
    await user.click(screen.getByRole('button',{name:'Hand off lead'}));
    await waitFor(()=>expect(mocks.submitMyLeadHandoffDrip).toHaveBeenCalledTimes(2));
    expect(mocks.submitMyLeadHandoffDrip.mock.calls[1][0]).toMatchObject({expectedQueueVersion:2,sequenceId:'drip-1'});
  });
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
  const settle = { timeout: 5000 };
  beforeEach(()=>{vi.resetAllMocks();mocks.loadMyLeadCallReferences.mockResolvedValue({ok:true,options:[]});});
  async function afterReadiness(){
    const user=userEvent.setup();const initial=snapshot("106 Fixture Lane");
    let release!:(value:unknown)=>void;
    mocks.loadMyLeads.mockReturnValueOnce(new Promise(resolve=>{release=resolve;}));
    mocks.submitMyLeadCommand.mockResolvedValue({ok:true});
    renderClient(initial);
    await user.click(screen.getByRole("button",{name:"Ready for offer"}));
    fireEvent.change(screen.getByLabelText("Motivation"), { target: { value: "Seller plans to relocate." } });
    await user.selectOptions(screen.getByLabelText("Temperature (optional)"),"warm");
    await user.click(screen.getByRole("button",{name:"Save readiness"}));
    await waitFor(()=>expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), settle);
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
  it.each(["foreground","background"])("a later authorized %s queue refresh replaces a failed barrier for future openings",async mode=>{
    const {user,fresh,release}=await afterReadiness();
    await act(async()=>release({ok:false,message:"First read failed"}));
    mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:fresh,kpis});
    if(mode==="background"){await user.click(screen.getByRole("button",{name:"Expand details"}));await act(async()=>window.dispatchEvent(new Event("focus")));}
    else await user.click(screen.getByRole("button",{name:"Retry now"}));
    await waitFor(()=>expect(screen.queryByText(/Displayed counts may be out of date/)).not.toBeInTheDocument(), settle);
    await user.click(screen.getByRole("button",{name:"Log offer"}));
    expect(await screen.findByRole("dialog", undefined, settle)).toBeVisible();
    expect(screen.queryByText(/Could not load current lead details/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Motivation")).not.toBeInTheDocument();
    expect(mocks.loadMyLeads).toHaveBeenCalledTimes(2);
    expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1);
  }, 15_000);
  it("retries an opening read failure without repeating the saved readiness command",async()=>{
    const {user,fresh,release}=await afterReadiness();await user.click(screen.getByRole("button",{name:"Log offer"}));
    await act(async()=>release({ok:false,message:"Read unavailable"}));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    mocks.loadMyLeads.mockResolvedValue({ok:true,snapshot:fresh,kpis});await user.click(screen.getByRole("button",{name:"Retry opening"}));
    expect(await screen.findByRole("dialog", undefined, settle)).toBeVisible();expect(screen.queryByLabelText("Motivation")).not.toBeInTheDocument();expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(1);
  }, 15_000);
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
