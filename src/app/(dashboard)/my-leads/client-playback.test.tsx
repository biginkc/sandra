import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AcquisitionKpis, AcquisitionRoster, QueueSnapshot } from "@/lib/my-leads/queries";
const mocks = vi.hoisted(() => ({ load: vi.fn(), detail: vi.fn(), stage: vi.fn(), routerRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.routerRefresh }) }));
vi.mock("@/components/softphone/softphone-provider", () => ({ useOptionalSoftphone: () => null }));
vi.mock("@/components/appointments/book-appointment-popover", () => ({ BookAppointmentPopover: () => null }));
vi.mock("./actions", () => ({ loadMyLeads: mocks.load, loadMyLeadDetail: mocks.detail, loadMyLeadsStage: mocks.stage,
  loadMyLeadCallReferences: vi.fn(), submitMyLeadCommand: vi.fn(), changeAcquisitionDesignation: vi.fn(), changeAcquisitionSettings: vi.fn() }));
import { MyLeadsClient } from "./client";
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
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


it("keeps the real recording player mounted through polling and focus updates that omit its paginated row", async () => {
  vi.useFakeTimers();
  const initial = snapshot("First page lead");
  const extraRow = { ...initial.stages.not_contacted!.rows[0], propertyId: "extra-lead", address: "Recorded lead" };
  initial.stages.not_contacted = { ...initial.stages.not_contacted!, totalCount: 2, filteredCount: 2, hasMore: true, cursor: "next-page" };
  mocks.stage.mockResolvedValue({ ok: true, snapshot: { ...initial, stages: { not_contacted: { ...initial.stages.not_contacted, rows: [extraRow], cursor: null, hasMore: false } } } });
  mocks.load.mockResolvedValue({ ok: true, snapshot: { ...initial, snapshotAt: "2026-09-11T14:01:00.000Z" }, kpis: { ...kpis, attempts: 8 } });
  mocks.detail.mockResolvedValue({ ok: true, detail: { groups: { attempts: { rows: [{ id: "attempt-1", at: initial.snapshotAt, actorId: "rep-1", source: "sandra", outcome: "reached", callActivityId: "call-1" }], cursor: null, hasMore: false } } } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => new Response(JSON.stringify(String(input).endsWith("/recording-url")
    ? { signedUrl: "https://example.test/recording.wav", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    : { recordingStatus: "available", durationSeconds: 300, transcriptStatus: "none", transcript: null, summaryStatus: "none", summary: null }), { status: 200 }));
  const view = render(<MyLeadsClient viewer={viewer} roster={roster} initialMemberId={viewer.userId} initialSnapshot={initial} initialKpis={kpis} />);
  try {
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more Not contacted" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Show details for Recorded lead" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load recording (300s)" })); });
    const audio = screen.getByTestId("sandra-recording-audio") as HTMLAudioElement;
    audio.currentTime = 17;
    fireEvent.play(audio);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByTestId("sandra-recording-audio")).toBe(audio);
    expect(audio.currentTime).toBe(17);
    expect(screen.getByTestId("kpi-contacts")).toHaveTextContent("8");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByTestId("sandra-recording-audio")).toBe(audio);
    expect(audio.currentTime).toBe(17);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(screen.getByTestId("sandra-recording-audio")).toBe(audio);
    expect(audio.currentTime).toBe(17);
    expect(mocks.routerRefresh).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Hide details for Recorded lead" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.queryByText("Recorded lead")).not.toBeInTheDocument();
  } finally { view.unmount(); }
});
