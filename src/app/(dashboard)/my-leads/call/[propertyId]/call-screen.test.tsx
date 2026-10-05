import { render, screen, within } from "@testing-library/react";
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
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));
vi.mock("@/app/(dashboard)/leads/actions", () => ({ markMessagesReadForProperty: mocks.markMessagesReadForProperty, createLeadNote: vi.fn() }));
vi.mock("@/app/(dashboard)/my-leads/actions", () => ({ loadMyLeadQueueRow: mocks.loadMyLeadQueueRow, savePostCallExtras: mocks.savePostCallExtras }));
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ listDripChoices: vi.fn(async () => ({ ok: true, data: [] })), startDripForLeads: vi.fn() }));
vi.mock("@/app/(dashboard)/my-leads/_components/use-attempt-workflow", () => ({ useAttemptWorkflow: mocks.useAttemptWorkflow }));
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
import { DIAL_UNAVAILABLE_COPY } from "./dial-stub";
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
    render(<CallScreen data={data} />);
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

  it("renders the Call button disabled until Phase 2 dialing lands", () => {
    render(<CallScreen data={data} />);
    expect(screen.getByTestId(`call-button-${propertyId}`)).toBeDisabled();
    expect(screen.getByTestId("call-dial-unavailable")).toHaveTextContent(DIAL_UNAVAILABLE_COPY);
  });

  it("shows texts read-only and never marks them read", async () => {
    const user = userEvent.setup();
    render(<CallScreen data={data} />);
    await user.click(screen.getByTestId("history-tab-texts"));
    expect(await screen.findByText("Is the offer still open?")).toBeInTheDocument();
    expect(mocks.markMessagesReadForProperty).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("keeps one opening (one attempt key) across a refresh at the same queue version, and a new one on a version change", () => {
    const openings = () => mocks.useAttemptWorkflow.mock.calls.map((call) => (call as unknown as [{ opening: unknown }])[0].opening);
    const { rerender } = render(<CallScreen data={data} />);
    // router.refresh() after a valuation save: new queueRow object, same version.
    rerender(<CallScreen data={{ ...data, queueRow: { ...data.queueRow } }} />);
    const same = openings();
    expect(new Set(same).size).toBe(1);
    rerender(<CallScreen data={{ ...data, queueRow: { ...data.queueRow, queueVersion: 2 } }} />);
    expect(new Set(openings()).size).toBe(2);
  });

  it("links back to My Leads", () => {
    render(<CallScreen data={data} />);
    expect(screen.getByRole("link", { name: "Back to My Leads" })).toHaveAttribute("href", "/my-leads");
  });
});
