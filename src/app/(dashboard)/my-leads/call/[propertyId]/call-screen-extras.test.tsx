import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

type WorkflowOptions = {
  opening: unknown;
  onCommitted: (c: unknown) => Promise<void>;
  onExtras: (f: unknown) => void;
};

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  loadMyLeadQueueRow: vi.fn(),
  savePostCallExtras: vi.fn(),
  useAttemptWorkflow: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/app/(dashboard)/my-leads/actions", () => ({ loadMyLeadQueueRow: mocks.loadMyLeadQueueRow, savePostCallExtras: mocks.savePostCallExtras }));
vi.mock("@/app/(dashboard)/my-leads/_components/use-attempt-workflow", () => ({ useAttemptWorkflow: mocks.useAttemptWorkflow }));
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ listDripChoices: vi.fn(async () => ({ ok: true, data: [] })), startDripForLeads: vi.fn() }));
vi.mock("./actions", () => ({ compLeadAction: vi.fn(), setValuationInputsAction: vi.fn() }));
vi.mock("./history-panel", () => ({ HistoryPanel: () => null }));
vi.mock("./numbers-card", () => ({ NumbersCard: () => null }));
vi.mock("./static-script-view", () => ({ StaticScriptView: () => null }));

import { getExtras, putExtras, resetExtrasStoreForTests, simulateExtrasReloadForTests } from "@/app/(dashboard)/my-leads/_components/extras-store";
import { CallScreen } from "./call-screen";
import type { CallScreenData } from "./types";

const propertyId = "11111111-1111-4111-8111-111111111111";
const data: CallScreenData = {
  viewer: { userId: "user-1", orgId: "org-1", isOwner: false },
  lead: {
    propertyId, address: "123 Main St", city: "Austin", state: "TX", zip: "78701", market: null, isTraining: false,
    homeowner: { contactId: "c-1", name: "Pat Seller", email: "", phones: [{ slot: 1, value: "+15555550101", type: "mobile" }] },
  },
  queueRow: {
    propertyId, stage: "contacted", queueVersion: 1, sharedStatus: "active", assignmentEpisodeId: "ep-1", assignedAt: null, initializedAt: "2026-10-01T00:00:00Z", episodeKind: "live",
    clockEligible: true, firstCallAt: null, stageEnteredAt: null, address: "123 Main St", city: "Austin", state: "TX", homeownerName: "Pat Seller", phone: "+15555550101", contactId: "c-1", phones: ["+15555550101"], contactDnc: false,
    temperature: null, motivationKind: null, motivationText: null, warningReasons: [], nextStepAt: null, nextStepType: null, offer: null, attemptsCount: 0,
  },
  script: { ok: false, message: "The script could not be loaded." },
  comps: { ok: true, data: { latest: null, request: null, settings: { enabled: false, capped: false }, valuation: { arv: null, rehab: null } } },
  notes: { ok: true, data: [] },
  messages: {
    ok: true,
    data: [
      { id: "m1", org_id: "org-1", property_id: propertyId, contact_id: "c-1", channel: "sms", direction: "inbound", body: "Is the offer still open?", created_at: "2026-10-03T15:00:00Z", status: "received", from_address: "+15555550101", to_address: "+15555550100" } as unknown as CallScreenData["messages"] extends { ok: true; data: (infer M)[] } ? M : never,
    ],
  },
  contract: { ok: false, message: "hidden" },
  facts: { ok: false, message: "hidden" },
};


const extras = { submissionId: "sub-1", note: "Seller wants 250k", nextStep: null };
const confirmed = { ok: true as const, note: "saved" as const, nextStep: "skipped" as const };
const options = () => mocks.useAttemptWorkflow.mock.calls.at(-1)![0] as WorkflowOptions;
const stash = () => putExtras({ viewerUserId: "user-1", attemptKey: "key-1", propertyId, memberId: "user-1", extras });
const committedInput = () => ({ opening: options().opening, attemptKey: "key-1", extras, input: {}, result: { ok: true }, dripFailure: null });
const withVersion = (queueVersion: number) => ({ ...data, queueRow: { ...data.queueRow, queueVersion } });

// Records the attempt through the REAL dock prompt, so it shows its receipt (and Retry) exactly as it does live.
async function recordAttempt(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(screen.getByTestId("post-call-outcome")).getByRole("radio", { name: "Reached" }));
  await user.type(screen.getByLabelText("Recording link (required)"), "https://dialpad.example/r/1");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByTestId("post-call-receipt");
}

describe("CallScreen post-call extras (real PostCallPrompt)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.savePostCallExtras.mockReset();
    resetExtrasStoreForTests();
    mocks.useAttemptWorkflow.mockReturnValue({
      submit: vi.fn(async () => ({ ok: true, attemptRecorded: true })),
      recoveryValue: null,
      onDripChanged: vi.fn(),
      confirmClose: vi.fn(),
    });
  });

  it("saves the note on a late-success / reconciliation flush (onExtras) and clears the stored entry once confirmed", async () => {
    mocks.savePostCallExtras.mockResolvedValue(confirmed);
    render(<CallScreen postCallPrompt data={data} />);
    stash();
    await act(async () => { options().onExtras({ opening: options().opening, attemptKey: "key-1", propertyId, memberId: "user-1", extras }); });
    expect(mocks.savePostCallExtras).toHaveBeenCalledWith({ memberId: "user-1", propertyId, submissionId: "sub-1", attemptKey: expect.any(String), callActivityId: null, note: "Seller wants 250k", nextStep: null });
    expect(getExtras("user-1", "key-1")).toBeNull();
  });

  it("failed extras: Retry stays reachable after the post-commit refresh (new queue version), then succeeds and clears", async () => {
    const user = userEvent.setup();
    mocks.savePostCallExtras.mockResolvedValueOnce({ ok: false, message: "The note and next step could not be saved." }).mockResolvedValueOnce(confirmed);
    const { rerender } = render(<CallScreen postCallPrompt data={data} />);
    await recordAttempt(user);
    stash();
    await act(async () => { await options().onCommitted(committedInput()); });
    // router.refresh() brings the row back at the next queue version: a new opening, same mounted prompt.
    rerender(<CallScreen postCallPrompt data={withVersion(2)} />);
    expect(screen.getByTestId("post-call-receipt")).toHaveTextContent("Note and next step not saved");
    expect(getExtras("user-1", "key-1")).not.toBeNull();
    await user.click(screen.getByTestId("post-call-retry-extras"));
    expect(mocks.savePostCallExtras).toHaveBeenCalledTimes(2);
    expect(mocks.savePostCallExtras.mock.calls[1][0].submissionId).toBe("sub-1");
    expect(getExtras("user-1", "key-1")).toBeNull();
    expect(screen.getByTestId("post-call-receipt")).toHaveTextContent("Note saved");
  });

  it("a partial failure keeps the stored entry and offers Retry", async () => {
    const user = userEvent.setup();
    mocks.savePostCallExtras.mockResolvedValue({ ok: true, note: "failed", nextStep: "skipped" });
    const { rerender } = render(<CallScreen postCallPrompt data={data} />);
    await recordAttempt(user);
    stash();
    await act(async () => { await options().onCommitted(committedInput()); });
    rerender(<CallScreen postCallPrompt data={withVersion(2)} />);
    expect(getExtras("user-1", "key-1")).not.toBeNull();
    expect(screen.getByTestId("post-call-receipt")).toHaveTextContent("Note not saved");
    expect(screen.getByTestId("post-call-retry-extras")).toBeVisible();
  });

  it("ASTRA at the call screen (matrix 5): reload banner Retry with no proof keeps the entry; once another key saved the call it is dropped, and no Retry remains", async () => {
    const user = userEvent.setup();
    stash();
    simulateExtrasReloadForTests();
    mocks.savePostCallExtras
      .mockResolvedValueOnce({ ok: false, pending: true, message: "Not saved yet: this call's save isn't confirmed. Your note is kept." })
      .mockResolvedValueOnce({ ok: false, message: "This was already saved. Refresh to see it.", alreadySaved: true });
    render(<CallScreen postCallPrompt data={data} />);
    const banner = await screen.findByTestId("call-screen-recovered-extras");
    await user.click(within(banner).getByTestId("post-call-retry-extras"));
    expect(await screen.findByText(/call's save isn't confirmed/)).toBeVisible();
    // A pending banner never claims the attempt was saved.
    expect(within(screen.getByTestId("call-screen-recovered-extras")).queryByText(/Attempt saved/)).toBeNull();
    expect(getExtras("user-1", "key-1")).not.toBeNull();
    await user.click(within(screen.getByTestId("call-screen-recovered-extras")).getByTestId("post-call-retry-extras"));
    await waitFor(() => expect(getExtras("user-1", "key-1")).toBeNull());
    await waitFor(() => expect(screen.queryByTestId("call-screen-recovered-extras")).toBeNull());
    expect(screen.queryByTestId("post-call-retry-extras")).toBeNull();
    expect(screen.queryByText(/Attempt saved/)).toBeNull();
    expect(mocks.savePostCallExtras).toHaveBeenCalledTimes(2);
    expect(mocks.savePostCallExtras.mock.calls[0][0]).toMatchObject({ attemptKey: "key-1" });
  });

  it("flag off (post_call_prompt): the call screen docks no prompt and offers no stored-extras banner or retry", async () => {
    stash();
    simulateExtrasReloadForTests();
    render(<CallScreen data={data} />);
    expect(screen.queryByTestId("call-screen-prompt-dock")).toBeNull();
    expect(screen.queryByTestId("post-call-prompt")).toBeNull();
    expect(screen.queryByTestId("call-screen-recovered-extras")).toBeNull();
    expect(mocks.savePostCallExtras).not.toHaveBeenCalled();
  });

  it("after a reload, a stored failed entry for this lead is surfaced with Retry and is saved then cleared", async () => {
    const user = userEvent.setup();
    stash();
    simulateExtrasReloadForTests(); // memory is gone; sessionStorage still holds the entry
    mocks.savePostCallExtras.mockResolvedValue(confirmed);
    render(<CallScreen postCallPrompt data={data} />);
    const banner = await screen.findByTestId("call-screen-recovered-extras");
    expect(banner).toHaveTextContent("not saved");
    expect(banner).toHaveTextContent("Seller wants 250k");
    await user.click(within(banner).getByTestId("post-call-retry-extras"));
    await waitFor(() => expect(screen.queryByTestId("call-screen-recovered-extras")).toBeNull());
    expect(mocks.savePostCallExtras).toHaveBeenCalledWith(expect.objectContaining({ submissionId: "sub-1", propertyId }));
    expect(getExtras("user-1", "key-1")).toBeNull();
  });

  it("shows nothing after a reload when there is no stored entry for this lead", () => {
    putExtras({ viewerUserId: "user-1", attemptKey: "other", propertyId: "22222222-2222-4222-8222-222222222222", memberId: "user-1", extras });
    render(<CallScreen postCallPrompt data={data} />);
    expect(screen.queryByTestId("call-screen-recovered-extras")).toBeNull();
  });
});
