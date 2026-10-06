import { render, screen, waitFor, within } from "@testing-library/react";
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
  acceptCallFactAction: vi.fn(),
  dismissCallFactsAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));
vi.mock("@/app/(dashboard)/leads/actions", () => ({ markMessagesReadForProperty: mocks.markMessagesReadForProperty, createLeadNote: vi.fn() }));
vi.mock("@/app/(dashboard)/my-leads/actions", () => ({ loadMyLeadQueueRow: mocks.loadMyLeadQueueRow, savePostCallExtras: mocks.savePostCallExtras }));
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ listDripChoices: vi.fn(async () => ({ ok: true, data: [] })), startDripForLeads: vi.fn() }));
vi.mock("@/app/(dashboard)/my-leads/_components/use-attempt-workflow", () => ({ useAttemptWorkflow: mocks.useAttemptWorkflow }));
vi.mock("./facts-actions", () => ({ acceptCallFactAction: mocks.acceptCallFactAction, dismissCallFactsAction: mocks.dismissCallFactsAction }));
vi.mock("./static-script-view", () => ({
  StaticScriptView: ({ entryFields }: { entryFields: Record<string, string | null> }) => <div data-testid="static-script-view" data-motivation={entryFields.motivation ?? ""} />,
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


const withFacts = (): CallScreenData => ({
  ...data,
  facts: { ok: true, data: { factId: "f1", chips: [{ field: "motivation", value: "must move by spring", evidence: "must move by spring" }, { field: "next_step", value: "2099-01-01T15:00:00.000Z", evidence: "call Friday" }] } },
});

describe("CallScreen call facts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acceptCallFactAction.mockResolvedValue({ ok: true, value: "must move by spring" });
    mocks.dismissCallFactsAction.mockResolvedValue({ ok: true });
  });

  it("mounts the chips right after the numbers card when a proposal is open", () => {
    render(<CallScreen postCallPrompt data={withFacts()} />);
    const right = screen.getByTestId("call-screen-right");
    const numbers = right.querySelector('[data-testid="numbers-card"]')!;
    const chips = within(right).getByTestId("call-fact-chips");
    expect(numbers.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chips.compareDocumentPosition(right.querySelector('[data-testid="history-panel"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders nothing for a missing or failed facts section", () => {
    render(<CallScreen postCallPrompt data={{ ...data, facts: { ok: true, data: null } }} />);
    expect(screen.queryByTestId("call-fact-chips")).toBeNull();
  });

  it("Accept sends the lead and fact ids; accepting motivation prefills the shared script field and refreshes", async () => {
    render(<CallScreen postCallPrompt data={withFacts()} />);
    expect(screen.getByTestId("static-script-view")).toHaveAttribute("data-motivation", "");
    await userEvent.click(screen.getByTestId("call-fact-accept-motivation"));
    expect(mocks.acceptCallFactAction).toHaveBeenCalledWith({ propertyId, factId: "f1", field: "motivation" });
    await waitFor(() => expect(screen.getByTestId("static-script-view")).toHaveAttribute("data-motivation", "must move by spring"));
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("accepting another field does not touch the motivation field", async () => {
    mocks.acceptCallFactAction.mockResolvedValue({ ok: true, value: "Fri" });
    render(<CallScreen postCallPrompt data={withFacts()} />);
    await userEvent.click(screen.getByTestId("call-fact-accept-next_step"));
    await waitFor(() => expect(mocks.acceptCallFactAction).toHaveBeenCalled());
    expect(screen.getByTestId("static-script-view")).toHaveAttribute("data-motivation", "");
  });

  it("Dismiss calls the dismiss action for the fact", async () => {
    render(<CallScreen postCallPrompt data={withFacts()} />);
    await userEvent.click(screen.getByTestId("call-fact-dismiss"));
    expect(mocks.dismissCallFactsAction).toHaveBeenCalledWith({ propertyId, factId: "f1" });
  });
});
