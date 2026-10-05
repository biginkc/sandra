import { act, render, screen } from "@testing-library/react";
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
  mounts: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/app/(dashboard)/my-leads/actions", () => ({ loadMyLeadQueueRow: mocks.loadMyLeadQueueRow, savePostCallExtras: mocks.savePostCallExtras }));
vi.mock("@/app/(dashboard)/my-leads/_components/use-attempt-workflow", () => ({ useAttemptWorkflow: mocks.useAttemptWorkflow }));
vi.mock("@/app/(dashboard)/my-leads/_components/post-call-prompt", async () => {
  const React = await import("react");
  return {
    PostCallPrompt: ({ extras, onRetryExtras }: { extras: { status: string; result?: { ok: boolean } } | null; onRetryExtras?: () => void }) => {
      React.useEffect(() => { mocks.mounts(); }, []);
      return (
        <div data-testid="post-call-prompt">
          <span data-testid="extras-status">{extras ? (extras.status === "done" ? (extras.result?.ok ? "done-ok" : "done-failed") : "saving") : "none"}</span>
          {onRetryExtras && <button type="button" onClick={onRetryExtras}>retry-extras</button>}
        </div>
      );
    },
  };
});
vi.mock("./actions", () => ({ compLeadAction: vi.fn(), setValuationInputsAction: vi.fn() }));
vi.mock("./history-panel", () => ({ HistoryPanel: () => null }));
vi.mock("./numbers-card", () => ({ NumbersCard: () => null }));
vi.mock("./static-script-view", () => ({ StaticScriptView: () => null }));

import { getExtras, putExtras, resetExtrasStoreForTests } from "@/app/(dashboard)/my-leads/_components/extras-store";
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

describe("CallScreen post-call extras", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetExtrasStoreForTests();
    mocks.useAttemptWorkflow.mockReturnValue({ submit: vi.fn(), recoveryValue: null, onDripChanged: vi.fn(), confirmClose: vi.fn() });
  });

  it("saves the note on a late-success / reconciliation flush (onExtras) and clears the stored entry once confirmed", async () => {
    mocks.savePostCallExtras.mockResolvedValue(confirmed);
    render(<CallScreen data={data} />);
    stash();
    await act(async () => { options().onExtras({ opening: options().opening, attemptKey: "key-1", propertyId, memberId: "user-1", extras }); });
    expect(mocks.savePostCallExtras).toHaveBeenCalledWith({ memberId: "user-1", propertyId, submissionId: "sub-1", note: "Seller wants 250k", nextStep: null });
    expect(getExtras("user-1", "key-1")).toBeNull();
    expect(screen.getByTestId("extras-status")).toHaveTextContent("done-ok");
  });

  it("keeps the stored entry after a failed save and a retry saves it again, clearing only on success", async () => {
    const user = userEvent.setup();
    mocks.savePostCallExtras.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(confirmed);
    render(<CallScreen data={data} />);
    stash();
    await act(async () => {
      await options().onCommitted({ opening: options().opening, attemptKey: "key-1", extras, input: {}, result: { ok: true }, dripFailure: null });
    });
    expect(screen.getByTestId("extras-status")).toHaveTextContent("done-failed");
    expect(getExtras("user-1", "key-1")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "retry-extras" }));
    expect(mocks.savePostCallExtras).toHaveBeenCalledTimes(2);
    expect(mocks.savePostCallExtras.mock.calls[1][0].submissionId).toBe("sub-1");
    expect(getExtras("user-1", "key-1")).toBeNull();
    expect(screen.getByTestId("extras-status")).toHaveTextContent("done-ok");
  });

  it("does not clear the stored entry when the server reports a partial failure", async () => {
    mocks.savePostCallExtras.mockResolvedValue({ ok: true, note: "failed", nextStep: "skipped" });
    render(<CallScreen data={data} />);
    stash();
    await act(async () => { options().onExtras({ opening: options().opening, attemptKey: "key-1", propertyId, memberId: "user-1", extras }); });
    expect(getExtras("user-1", "key-1")).not.toBeNull();
  });

  it("starts a fresh prompt for a new opening (new queue version) but never remounts the same opening", () => {
    const { rerender } = render(<CallScreen data={data} />);
    expect(mocks.mounts).toHaveBeenCalledTimes(1);
    // Same version, new row object (a refresh that is not a new opening): same prompt, same opening.
    const openingBefore = options().opening;
    rerender(<CallScreen data={{ ...data, queueRow: { ...data.queueRow } }} />);
    expect(mocks.mounts).toHaveBeenCalledTimes(1);
    expect(options().opening).toBe(openingBefore);
    // After a committed attempt the row comes back at a new version: fresh prompt, fresh opening.
    rerender(<CallScreen data={{ ...data, queueRow: { ...data.queueRow, queueVersion: 2 } }} />);
    expect(mocks.mounts).toHaveBeenCalledTimes(2);
    expect(options().opening).not.toBe(openingBefore);
  });
});
