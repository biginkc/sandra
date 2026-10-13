import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { InboxDetail } from "./inbox-detail";
import type { InboxDetail as InboxDetailData } from "./inbox-detail-data";
import type { Database } from "@/lib/supabase/types";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

// In-test holder for the most recent router-replace destination so the
// ESC-closes-and-clears-?thread test can assert on the URL the panel
// would push.
const replaceCalls: string[] = [];
const refreshCalls: number[] = [];
const pushCalls: string[] = [];
let navigationSearch = "";
const setOutreachDispoMock = vi.hoisted(() => vi.fn());
const setInboxDispoAndStartDripMock = vi.hoisted(() => vi.fn());
const listDripChoicesMock = vi.hoisted(() => vi.fn());
const startDripForLeadsMock = vi.hoisted(() => vi.fn());
const changeDripActionMock = vi.hoisted(() => vi.fn());
const moveMessageThreadToLeadMock = vi.hoisted(() => vi.fn());
const confirmAiDispositionReviewMock = vi.hoisted(() => vi.fn());
const supabaseMock = vi.hoisted(() => {
  const subscriptions: Array<{
    type: string;
    filter: Record<string, unknown>;
    callback: (payload: { new: MessageRow }) => void;
  }> = [];
  const channel = {
    on: vi.fn(
      (
        type: string,
        filter: Record<string, unknown>,
        callback: (payload: { new: MessageRow }) => void,
      ) => {
        subscriptions.push({ type, filter, callback });
        return channel;
      },
    ),
    subscribe: vi.fn(() => channel),
  };
  return {
    subscriptions,
    client: {
      auth: {
        getSession: vi.fn(async () => ({ data: { session: null } })),
      },
      realtime: {
        setAuth: vi.fn(),
      },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn((url: string) => {
      pushCalls.push(url);
    }),
    replace: vi.fn((url: string) => {
      replaceCalls.push(url);
    }),
    refresh: vi.fn(() => {
      refreshCalls.push(Date.now());
    }),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(navigationSearch),
  usePathname: () => "/messages",
}));

vi.mock("./dispo-actions", () => ({
  confirmAiDispositionReview: confirmAiDispositionReviewMock,
  setOutreachDispo: setOutreachDispoMock,
  setInboxDispoAndStartDrip: setInboxDispoAndStartDripMock,
  moveMessageThreadToLead: moveMessageThreadToLeadMock,
}));
vi.mock("@/app/(dashboard)/sequences/actions", () => ({
  listDripChoices: listDripChoicesMock,
  startDripForLeads: startDripForLeadsMock,
  changeDripAction: changeDripActionMock,
}));

// Server-action modules ("use server" at top) cannot be imported in jsdom —
// they pull in next/server's `after` and the Supabase server client.
vi.mock("../leads/actions", () => ({
  listFromNumbers: vi.fn(async () => ({ ok: true, data: [] })),
  sendSmsFromLead: vi.fn(),
  loadLeadVars: vi.fn(async () => ({ ok: true, data: {} })),
  listOrgUsers: vi.fn(async () => ({ ok: true, data: [] })),
  listPropertyOrgUsers: vi.fn(async () => ({ ok: true, data: [] })),
  updateLeadAssignee: vi.fn(),
}));

vi.mock("../leads/queue-norma-actions", () => ({ queueNormaCalls: vi.fn() }));

vi.mock("../templates/actions", () => ({
  listTemplates: vi.fn(async () => ({ ok: true, data: [] })),
}));

// MessagesThread + InboxThreadList both subscribe to Supabase Realtime on
// mount. Stub the browser client so the channel pipeline is a no-op.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => supabaseMock.client,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/components/appointments/book-appointment-popover", () => ({
  BookAppointmentPopover: ({
    onBooked,
    triggerLabel,
  }: {
    onBooked: () => void;
    triggerLabel: string;
  }) => (
    <button data-testid="book-appointment" onClick={onBooked}>
      {triggerLabel}
    </button>
  ),
}));

function makeMessage(
  overrides: Partial<MessageRow> & {
    id: string;
    body: string;
    direction: "inbound" | "outbound";
  },
): MessageRow {
  return {
    id: overrides.id,
    body: overrides.body,
    direction: overrides.direction,
    status:
      overrides.status ??
      (overrides.direction === "inbound" ? "received" : "sent"),
    channel: "sms",
    contact_id: overrides.contact_id ?? "contact-1",
    property_id: overrides.property_id ?? "prop-1",
    conversation_id:
      overrides.conversation_id ??
      `conv-${overrides.contact_id ?? "contact-1"}`,
    from_address:
      overrides.from_address ??
      (overrides.direction === "inbound" ? "+15551234567" : "+18162804181"),
    to_address:
      overrides.to_address ??
      (overrides.direction === "inbound" ? "+18162804181" : "+15551234567"),
    created_at: overrides.created_at ?? "2026-04-29T12:00:00Z",
    read_at: overrides.read_at ?? null,
    metadata: overrides.metadata ?? null,
    // The schema has additional columns that are nullable for our
    // purposes — the cast keeps the test focused on what the panel
    // actually reads.
  } as MessageRow;
}

function makeData(
  overrides: Partial<InboxDetailData> & { contactId: string },
): InboxDetailData {
  const contactId = overrides.contactId;
  const propertyId = Object.hasOwn(overrides, "propertyId")
    ? overrides.propertyId!
    : "prop-1";
  return {
    threadId: overrides.threadId ?? `conv-${contactId}`,
    conversationId: overrides.conversationId ?? `conv-${contactId}`,
    contactId,
    contactName: overrides.contactName ?? "Panel Test",
    threadCustomerPhone: Object.hasOwn(overrides, "threadCustomerPhone")
      ? overrides.threadCustomerPhone!
      : "+15551234567",
    threadBusinessPhone: Object.hasOwn(overrides, "threadBusinessPhone")
      ? overrides.threadBusinessPhone!
      : "+18162804181",
    contactPhone: Object.hasOwn(overrides, "contactPhone")
      ? overrides.contactPhone!
      : "+15551234567",
    replyToPhone: Object.hasOwn(overrides, "replyToPhone")
      ? overrides.replyToPhone!
      : "+15551234567",
    replyToPhoneLineType: Object.hasOwn(overrides, "replyToPhoneLineType")
      ? overrides.replyToPhoneLineType!
      : "mobile",
    propertyId,
    propertyAddress: Object.hasOwn(overrides, "propertyAddress")
      ? overrides.propertyAddress!
      : "123 Main St, Albany, NY",
    homeownerContactId: Object.hasOwn(overrides, "homeownerContactId")
      ? overrides.homeownerContactId!
      : contactId,
    agentContactId: overrides.agentContactId ?? null,
    assigneeId: overrides.assigneeId ?? null,
    propertyStatus: overrides.propertyStatus ?? "prospect",
    outreachDispo: overrides.outreachDispo ?? null,
    aiDispositionReview: overrides.aiDispositionReview ?? null,
    contactDoNotContact: overrides.contactDoNotContact ?? false,
    contactSmsOptedOut: overrides.contactSmsOptedOut ?? false,
    smsConsentState: Object.hasOwn(overrides, "smsConsentState")
      ? overrides.smsConsentState!
      : "can_send_marketing",
    phoneSuppressed: Object.hasOwn(overrides, "phoneSuppressed")
      ? overrides.phoneSuppressed!
      : false,
    smsSafetyReadFailed: overrides.smsSafetyReadFailed ?? false,
    isDncLocked: overrides.isDncLocked ?? false,
    drip: overrides.drip ?? null,
    dripMessageLabels: overrides.dripMessageLabels ?? {},
    dripReplyMessageIds: overrides.dripReplyMessageIds ?? [],
    dripReplyLabels: overrides.dripReplyLabels ?? {},
    initialMessages: overrides.initialMessages ?? [],
  };
}


// The real QueueNormaAction (./queue-norma-action) is covered in queue-norma-action.test.tsx; here it is stubbed so this file
// only pins the WIRING: shown iff data.propertyId resolves, and given that property id.
vi.mock("./queue-norma-action", () => ({
  QueueNormaAction: ({ propertyId }: { propertyId: string }) => (
    <button type="button" data-testid="inbox-detail-queue-norma" data-property-id={propertyId} />
  ),
}));

describe("<InboxDetail /> Queue Norma action (plan UI: Messages thread action on resolved data.propertyId)", () => {
  it("is shown, bound to the property, when the thread resolves to a lead", () => {
    const data = makeData({ contactId: "contact-q1", propertyId: "prop-q1", initialMessages: [] });
    render(<InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />);
    expect(screen.getByTestId("inbox-detail-queue-norma")).toHaveAttribute("data-property-id", "prop-q1");
  });

  it("is hidden when data.propertyId is unresolved", () => {
    const data = makeData({ contactId: "contact-q2", propertyId: null as unknown as string, propertyAddress: null, initialMessages: [] });
    render(<InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />);
    expect(screen.queryByTestId("inbox-detail-queue-norma")).toBeNull();
  });

  it("is NOT hidden for a DNC-locked lead (enqueue itself reports the block)", () => {
    const data = makeData({ contactId: "contact-q3", propertyId: "prop-q3", isDncLocked: true, contactDoNotContact: true, initialMessages: [] });
    render(<InboxDetail data={data} assigneeEmails={{}} currentUserId="user-1" />);
    expect(screen.getByTestId("inbox-detail-queue-norma")).toHaveAttribute("data-property-id", "prop-q3");
  });
});
