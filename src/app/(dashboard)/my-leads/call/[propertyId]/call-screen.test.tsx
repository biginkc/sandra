import { screen, waitFor, within } from "@testing-library/react"
import { renderWithDialpad as render } from "@/components/dialpad/test-shell";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  markMessagesReadForProperty: vi.fn(),
  loadMyLeadQueueRow: vi.fn(),
  savePostCallExtras: vi.fn(),
  compLeadAction: vi.fn(),
  setValuationInputsAction: vi.fn(),
  useAttemptWorkflow: vi.fn(() => ({ submit: vi.fn(), recoveryValue: null, onDripChanged: vi.fn(), confirmClose: vi.fn() })),
  subscribe: vi.fn(),
  dialLead: vi.fn(),
  dialStatus: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));
vi.mock("@/app/(dashboard)/leads/actions", () => ({ markMessagesReadForProperty: mocks.markMessagesReadForProperty, createLeadNote: vi.fn() }));
vi.mock("@/app/(dashboard)/my-leads/actions", () => ({ loadMyLeadQueueRow: mocks.loadMyLeadQueueRow, savePostCallExtras: mocks.savePostCallExtras }));
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ listDripChoices: vi.fn(async () => ({ ok: true, data: [] })), startDripForLeads: vi.fn() }));
vi.mock("@/app/(dashboard)/my-leads/_components/use-attempt-workflow", () => ({ useAttemptWorkflow: mocks.useAttemptWorkflow }));
vi.mock("@/app/(dashboard)/my-leads/dialpad-actions", () => ({
  dialLeadAction: mocks.dialLead,
  getDialpadCallStatusAction: (...a: unknown[]) => mocks.dialStatus(...a),
}));
vi.mock("./actions", () => ({ compLeadAction: mocks.compLeadAction, setValuationInputsAction: mocks.setValuationInputsAction }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }) },
    realtime: { setAuth: vi.fn() },
    channel: () => ({ on: function () { return this; }, subscribe: function () { mocks.subscribe(); return this; }, unsubscribe: vi.fn() }),
    removeChannel: vi.fn(),
  }),
}));

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

describe("CallScreen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the D7 layout: header, script left, numbers → history → docked prompt right; contract and facts omitted", () => {
    render(<CallScreen postCallPrompt data={data} />);
    expect(screen.getByTestId("call-screen-header")).toHaveTextContent("Pat Seller");
    expect(screen.getByTestId("call-screen-stage")).toHaveTextContent("Contacted");
    expect(within(screen.getByTestId("call-screen-left")).getByTestId("static-script-view")).toBeInTheDocument();
    const right = screen.getByTestId("call-screen-right");
    const order = [right.querySelector('[data-testid="numbers-card"]'), right.querySelector('[data-testid="history-panel"]'), right.querySelector('[data-testid="call-screen-prompt-dock"]')];
    expect(order.every(Boolean)).toBe(true);
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("post-call-prompt")).toHaveAttribute("data-variant", "dock");
    expect(screen.queryByTestId("send-contract-card")).toBeNull();
    expect(screen.queryByText(/call facts/i)).toBeNull();
  });

  describe("Call button (shared My Leads dial path)", () => {
    const callButton = () => screen.getByTestId(`call-button-${propertyId}`);
    const dialData = (over: Partial<CallScreenData["queueRow"]> = {}) => ({ ...data, queueRow: { ...data.queueRow, ...over } });
    const rawKeys = () => mocks.dialLead.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);

    beforeEach(() => {
      mocks.dialStatus.mockResolvedValue({ ok: true, status: { state: "dialing" } });
    });

    it("is disabled and dials nothing when click_to_dial / api_dial readiness is off", async () => {
      const user = userEvent.setup();
      render(<CallScreen postCallPrompt data={data} clickToDial={false} />);
      expect(callButton()).toBeDisabled();
      await user.click(callButton());
      expect(mocks.dialLead).not.toHaveBeenCalled();
      expect(screen.queryByTestId("dial-status")).toBeNull();
    });

    it("stays disabled with no contact, no phone, or a do-not-call contact even when the flag is on", () => {
      const { rerender } = render(<CallScreen postCallPrompt data={dialData({ contactDnc: true })} clickToDial />);
      expect(callButton()).toBeDisabled();
      rerender(<CallScreen postCallPrompt data={{ ...data, lead: { ...data.lead, homeowner: { ...data.lead.homeowner, contactId: null } } }} clickToDial />);
      expect(callButton()).toBeDisabled();
      rerender(<CallScreen postCallPrompt data={{ ...data, lead: { ...data.lead, homeowner: { ...data.lead.homeowner, phones: [] } } }} clickToDial />);
      expect(callButton()).toBeDisabled();
    });

    it("dispatches through dialLeadAction with the lead, contact and a key when the flag is on", async () => {
      const user = userEvent.setup();
      mocks.dialLead.mockResolvedValue({ ok: true, intentId: "i-1", state: "dialing", uncertain: false });
      render(<CallScreen postCallPrompt data={data} clickToDial />);
      expect(callButton()).toBeEnabled();
      await user.click(callButton());
      expect(mocks.dialLead).toHaveBeenCalledTimes(1);
      expect(mocks.dialLead.mock.calls[0]![0]).toMatchObject({ propertyId, contactId: "c-1", idempotencyKey: expect.any(String) });
      expect(await screen.findByTestId("dial-status")).toHaveTextContent("Pat Seller");
      expect(mocks.dialStatus).toHaveBeenCalledWith("i-1");
    });

    it("reuses the key on a retry after an expired replay, and Dismiss of that caution mints a fresh key", async () => {
      const user = userEvent.setup();
      mocks.dialLead.mockResolvedValue({ ok: false, code: "expired", message: "This call may have rung. Check Dialpad." });
      render(<CallScreen postCallPrompt data={data} clickToDial />);
      await user.click(callButton());
      await screen.findByTestId("dial-status");
      await user.click(callButton());
      await waitFor(() => expect(mocks.dialLead).toHaveBeenCalledTimes(2));
      const [first, second] = rawKeys();
      expect(second).toBe(first);
      await user.click(screen.getByRole("button", { name: "Dismiss" }));
      await user.click(callButton());
      await waitFor(() => expect(mocks.dialLead).toHaveBeenCalledTimes(3));
      expect(rawKeys()[2]).not.toBe(first);
    });

    it("after a thrown request (it may have dialed) the Call button stays disabled while the hold lasts, and the key is kept", async () => {
      const user = userEvent.setup();
      mocks.dialLead.mockRejectedValue(new Error("network"));
      render(<CallScreen postCallPrompt data={data} clickToDial />);
      await user.click(callButton());
      await screen.findByTestId("dial-status");
      // The lock is held for a possibly-ringing call: no second dial is offered.
      await waitFor(() => expect(callButton()).toBeDisabled());
      expect(mocks.dialLead).toHaveBeenCalledTimes(1);
      expect(rawKeys()).toHaveLength(1);
    });

    it("releases the key on a server-proven non-dispatch (freshAttemptKey)", async () => {
      const user = userEvent.setup();
      mocks.dialLead.mockResolvedValue({ ok: false, code: "provider_rejected", message: "Nothing was dialed.", freshAttemptKey: true });
      render(<CallScreen postCallPrompt data={data} clickToDial />);
      await user.click(callButton());
      await screen.findByTestId("dial-status");
      await user.click(callButton());
      await waitFor(() => expect(mocks.dialLead).toHaveBeenCalledTimes(2));
      expect(rawKeys()[1]).not.toBe(rawKeys()[0]);
    });

    it("a failed call holds until Mark call ended (Dismiss only hides it); an ended poll releases the key so the next click mints a new one", async () => {
      const user = userEvent.setup();
      mocks.dialLead.mockResolvedValue({ ok: true, intentId: "i-1", state: "dialing", uncertain: false });
      mocks.dialStatus.mockResolvedValue({ ok: true, status: { state: "failed" } });
      const { unmount } = render(<CallScreen postCallPrompt data={data} clickToDial />);
      await user.click(callButton());
      await screen.findByText(/It may have rung/);
      // `failed` is not final: Dismiss only hides the panel (lock and key stay) and the lead is not dialed again.
      await user.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(mocks.dialLead).toHaveBeenCalledTimes(1);
      // The panel is hidden but the call is still tracked; the rep brings it back and confirms the call really ended; only then is the key released.
      await user.click(await screen.findByTestId("dialpad-call-show"));
      await user.click(await screen.findByRole("button", { name: "Mark call ended" }));
      await user.click(screen.getByRole("button", { name: "Yes, it ended" }));
      unmount();

      mocks.dialLead.mockClear();
      mocks.dialStatus.mockResolvedValue({ ok: true, status: { state: "ended", connected: true, durationSeconds: 5, callActivityId: null } });
      render(<CallScreen postCallPrompt data={data} clickToDial />);
      await user.click(callButton());
      await screen.findByText(/Call ended/);
      await user.click(callButton());
      await waitFor(() => expect(mocks.dialLead).toHaveBeenCalledTimes(2));
      expect(rawKeys()[1]).not.toBe(rawKeys()[0]);
    });

    it("offers Call again anyway on prior_call_unresolved and sends confirmRedialOf with a new key", async () => {
      const user = userEvent.setup();
      mocks.dialLead.mockResolvedValueOnce({ ok: false, code: "prior_call_unresolved", message: "An earlier call may have rung.", priorIntentId: "i-0" });
      render(<CallScreen postCallPrompt data={data} clickToDial />);
      await user.click(callButton());
      mocks.dialLead.mockResolvedValueOnce({ ok: true, intentId: "i-2", state: "dialing", uncertain: false });
      await user.click(await screen.findByRole("button", { name: "Call again anyway" }));
      await waitFor(() => expect(mocks.dialLead).toHaveBeenCalledTimes(2));
      expect(mocks.dialLead.mock.calls[1]![0]).toMatchObject({ confirmRedialOf: "i-0" });
    });
  });

  it("shows texts read-only and never marks them read", async () => {
    const user = userEvent.setup();
    render(<CallScreen postCallPrompt data={data} />);
    await user.click(screen.getByTestId("history-tab-texts"));
    expect(await screen.findByText("Is the offer still open?")).toBeInTheDocument();
    expect(mocks.markMessagesReadForProperty).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("keeps one opening (one attempt key) across a refresh at the same queue version, and a new one on a version change", () => {
    const openings = () => mocks.useAttemptWorkflow.mock.calls.map((call) => (call as unknown as [{ opening: unknown }])[0].opening);
    const { rerender } = render(<CallScreen postCallPrompt data={data} />);
    // router.refresh() after a valuation save: new queueRow object, same version.
    rerender(<CallScreen postCallPrompt data={{ ...data, queueRow: { ...data.queueRow } }} />);
    const same = openings();
    expect(new Set(same).size).toBe(1);
    rerender(<CallScreen postCallPrompt data={{ ...data, queueRow: { ...data.queueRow, queueVersion: 2 } }} />);
    expect(new Set(openings()).size).toBe(2);
  });

  it("links back to My Leads", () => {
    render(<CallScreen postCallPrompt data={data} />);
    expect(screen.getByRole("link", { name: "Back to My Leads" })).toHaveAttribute("href", "/my-leads");
  });
});
