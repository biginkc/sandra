import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
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
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/messages",
}));

// Server-action modules ("use server" at top) cannot be imported in jsdom —
// they pull in next/server's `after` and the Supabase server client.
vi.mock("../leads/actions", () => ({
  listFromNumbers: vi.fn(async () => ({ ok: true, data: [] })),
  sendSmsFromLead: vi.fn(),
  loadLeadVars: vi.fn(async () => ({ ok: true, data: {} })),
  listOrgUsers: vi.fn(async () => ({ ok: true, data: [] })),
  updateLeadAssignee: vi.fn(),
}));

vi.mock("../templates/actions", () => ({
  listTemplates: vi.fn(async () => ({ ok: true, data: [] })),
}));

// MessagesThread + InboxThreadList both subscribe to Supabase Realtime on
// mount. Stub the browser client so the channel pipeline is a no-op.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
    realtime: {
      setAuth: vi.fn(),
    },
    channel: () => {
      const ch = {
        on: () => ch,
        subscribe: () => ch,
      };
      return ch;
    },
    removeChannel: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

function makeMessage(overrides: Partial<MessageRow> & { id: string; body: string; direction: "inbound" | "outbound" }): MessageRow {
  return {
    id: overrides.id,
    body: overrides.body,
    direction: overrides.direction,
    status: overrides.direction === "inbound" ? "received" : "sent",
    channel: "sms",
    contact_id: overrides.contact_id ?? "contact-1",
    property_id: overrides.property_id ?? "prop-1",
    conversation_id:
      overrides.conversation_id ?? `conv-${overrides.contact_id ?? "contact-1"}`,
    from_address: overrides.direction === "inbound" ? "+15551234567" : "+18162804181",
    to_address: overrides.direction === "inbound" ? "+18162804181" : "+15551234567",
    created_at: overrides.created_at ?? "2026-04-29T12:00:00Z",
    read_at: overrides.read_at ?? null,
    metadata: overrides.metadata ?? null,
    // The schema has additional columns that are nullable for our
    // purposes — the cast keeps the test focused on what the panel
    // actually reads.
  } as MessageRow;
}

function makeData(overrides: Partial<InboxDetailData> & { contactId: string }): InboxDetailData {
  const contactId = overrides.contactId;
  const propertyId = overrides.propertyId ?? "prop-1";
  return {
    threadId: overrides.threadId ?? `conv-${contactId}`,
    conversationId: overrides.conversationId ?? `conv-${contactId}`,
    contactId,
    contactName: overrides.contactName ?? "Panel Test",
    contactPhone: overrides.contactPhone ?? "+15551234567",
    propertyId,
    propertyAddress: overrides.propertyAddress ?? "123 Main St, Albany, NY",
    assigneeId: overrides.assigneeId ?? null,
    propertyStatus: overrides.propertyStatus ?? "prospect",
    outreachDispo: overrides.outreachDispo ?? null,
    initialMessages: overrides.initialMessages ?? [],
  };
}

describe("<InboxDetail />", () => {
  it("renders the empty placeholder when no thread is selected (test 14 baseline)", () => {
    render(
      <InboxDetail
        data={null}
        assigneeEmails={{}}
        currentUserId="user-1"
      />,
    );
    expect(screen.getByTestId("inbox-detail-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-detail-panel")).not.toBeInTheDocument();
  });

  it("renders the side panel with conversation bubbles (tests 14 + 15)", () => {
    const data = makeData({
      contactId: "contact-1",
      initialMessages: [
        makeMessage({
          id: "m1",
          body: "first outbound",
          direction: "outbound",
          created_at: "2026-04-29T11:30:00Z",
        }),
        makeMessage({
          id: "m2",
          body: "first inbound",
          direction: "inbound",
          created_at: "2026-04-29T11:40:00Z",
        }),
      ],
    });

    const { container } = render(
      <InboxDetail
        data={data}
        assigneeEmails={{}}
        currentUserId="user-1"
      />,
    );

    const panel = screen.getByTestId("inbox-detail-panel");
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent("first outbound");
    expect(panel).toHaveTextContent("first inbound");

    // Outbound bubble uses bg-primary, inbound uses bg-muted.
    expect(container.querySelector(".bg-primary")).not.toBeNull();
    expect(container.querySelector(".bg-muted")).not.toBeNull();
  });

  it("ESC closes the panel by clearing ?thread (test 16)", async () => {
    replaceCalls.length = 0;
    refreshCalls.length = 0;

    const user = userEvent.setup();
    const data = makeData({
      contactId: "contact-esc",
      initialMessages: [
        makeMessage({
          id: "m1",
          body: "open me",
          direction: "inbound",
        }),
      ],
    });

    render(
      <InboxDetail
        data={data}
        assigneeEmails={{}}
        currentUserId="user-1"
      />,
    );

    expect(screen.getByTestId("inbox-detail-panel")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    // The panel calls router.replace("/messages") (no query string left)
    // and router.refresh() to drop the side-panel data on the server
    // round-trip.
    expect(replaceCalls).toContain("/messages");
    expect(refreshCalls.length).toBeGreaterThan(0);
  });

  it("switching threads remounts MessagesThread with the new contact (test 17)", () => {
    const aData = makeData({
      contactId: "contact-a",
      contactName: "Contact A",
      initialMessages: [
        makeMessage({
          id: "ma",
          body: "hello from A",
          direction: "inbound",
          contact_id: "contact-a",
        }),
      ],
    });
    const bData = makeData({
      contactId: "contact-b",
      contactName: "Contact B",
      initialMessages: [
        makeMessage({
          id: "mb",
          body: "hello from B",
          direction: "inbound",
          contact_id: "contact-b",
        }),
      ],
    });

    const { rerender } = render(
      <InboxDetail
        data={aData}
        assigneeEmails={{}}
        currentUserId="user-1"
      />,
    );

    expect(screen.getByTestId("inbox-detail-panel")).toHaveTextContent(
      "hello from A",
    );

    rerender(
      <InboxDetail
        data={bData}
        assigneeEmails={{}}
        currentUserId="user-1"
      />,
    );

    const panel = screen.getByTestId("inbox-detail-panel");
    expect(panel).toHaveTextContent("hello from B");
    expect(panel).not.toHaveTextContent("hello from A");
  });

  it("switching threads for the same contact resets the inline reply draft", async () => {
    const user = userEvent.setup();
    const aData = makeData({
      contactId: "contact-a",
      propertyId: "prop-a",
      threadId: "conv-contact-a-prop-a",
      conversationId: "conv-contact-a-prop-a",
      initialMessages: [
        makeMessage({
          id: "ma",
          body: "hello from property A",
          direction: "inbound",
          contact_id: "contact-a",
          property_id: "prop-a",
        }),
      ],
    });
    const bData = makeData({
      contactId: "contact-a",
      propertyId: "prop-b",
      threadId: "conv-contact-a-prop-b",
      conversationId: "conv-contact-a-prop-b",
      initialMessages: [
        makeMessage({
          id: "mb",
          body: "hello from property B",
          direction: "inbound",
          contact_id: "contact-a",
          property_id: "prop-b",
        }),
      ],
    });

    const { rerender } = render(
      <InboxDetail
        data={aData}
        assigneeEmails={{}}
        currentUserId="user-1"
      />,
    );

    const textarea = screen.getByLabelText("Reply to this lead");
    await user.type(textarea, "draft for property A");
    expect(textarea).toHaveValue("draft for property A");

    rerender(
      <InboxDetail
        data={bData}
        assigneeEmails={{}}
        currentUserId="user-1"
      />,
    );

    expect(screen.getByLabelText("Reply to this lead")).toHaveValue("");
  });
});
