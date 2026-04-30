import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { CockpitView } from "./cockpit-view";
import type { InboxDetail as InboxDetailData } from "./inbox-detail-data";
import type { Thread } from "@/lib/messages/list-threads";
import type { Database } from "@/lib/supabase/types";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/messages",
}));

// Server-action modules can't load in jsdom (next/server, supabase server).
vi.mock("./actions", () => ({
  releaseMessage: vi.fn(),
  pauseQueuedMessage: vi.fn(),
  resumeQueuedMessage: vi.fn(),
  cancelQueuedMessage: vi.fn(),
  updateQueuedMessage: vi.fn(),
  matchUnknownSender: vi.fn(),
  createContactFromUnknown: vi.fn(),
  dismissUnknownSender: vi.fn(),
  restoreDismissedSender: vi.fn(),
  mergeUnknownSenderToProperty: vi.fn(),
}));

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

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
    realtime: { setAuth: vi.fn() },
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
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

// queue-panel reads/writes localStorage on mount for the cadence
// preference. The jsdom env exposes `localStorage` as an empty object
// without method hooks (jsdom needs `--localstorage-file` to fully
// activate), so install a minimal in-memory Storage shim before the
// component tree mounts. Scoped to this test file only — global setup
// is owned by the harness.
beforeAll(() => {
  const store = new Map<string, string>();
  const ls: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? (store.get(key) ?? null) : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get: () => ls,
  });
});

function makeThread(overrides: Partial<Thread> & { contactId: string }): Thread {
  return {
    contactId: overrides.contactId,
    contactName: overrides.contactName ?? `Contact ${overrides.contactId}`,
    contactPhone: overrides.contactPhone ?? "+15551234567",
    propertyId: overrides.propertyId ?? `prop-${overrides.contactId}`,
    propertyAddress: overrides.propertyAddress ?? "123 Main St",
    lastMessageAt: overrides.lastMessageAt ?? "2026-04-29T12:00:00Z",
    lastMessageBody: overrides.lastMessageBody ?? "hello",
    lastMessageDirection: overrides.lastMessageDirection ?? "inbound",
    unreadCount: overrides.unreadCount ?? 0,
    assigneeId: overrides.assigneeId ?? null,
  } as Thread;
}

function makeMessage(overrides: Partial<MessageRow> & { id: string; body: string; contact_id: string; property_id: string }): MessageRow {
  return {
    id: overrides.id,
    body: overrides.body,
    direction: overrides.direction ?? "inbound",
    status: overrides.status ?? "received",
    channel: "sms",
    contact_id: overrides.contact_id,
    property_id: overrides.property_id,
    from_address: "+15551234567",
    to_address: "+18162804181",
    created_at: overrides.created_at ?? "2026-04-29T12:00:00Z",
    read_at: null,
    metadata: null,
  } as MessageRow;
}

function makeDetail(contactId: string, body: string): InboxDetailData {
  return {
    contactId,
    contactName: `Contact ${contactId}`,
    contactPhone: "+15551234567",
    propertyId: `prop-${contactId}`,
    propertyAddress: "123 Main St, Albany, NY",
    assigneeId: null,
    initialMessages: [
      makeMessage({
        id: `m-${contactId}`,
        body,
        contact_id: contactId,
        property_id: `prop-${contactId}`,
      }),
    ],
  };
}

const baseProps = {
  filter: "all" as const,
  threads: [],
  queued: [],
  threadDetail: null,
  unknownSenders: [],
  unknownActiveCount: 0,
  assigneeEmails: {},
  currentUserId: "user-1",
};

describe("<CockpitView /> URL deep-linking", () => {
  it("activeTab='outbox' renders the Outbox tab as aria-selected (test 32)", () => {
    render(<CockpitView {...baseProps} activeTab="outbox" />);

    const outbox = screen.getByTestId("tab-outbox");
    const inbox = screen.getByTestId("tab-inbox");

    expect(outbox).toHaveAttribute("aria-selected", "true");
    expect(inbox).toHaveAttribute("aria-selected", "false");
  });

  it("activeTab='inbox' renders the Inbox tab as aria-selected (baseline for test 32)", () => {
    render(<CockpitView {...baseProps} activeTab="inbox" />);

    const outbox = screen.getByTestId("tab-outbox");
    const inbox = screen.getByTestId("tab-inbox");

    expect(inbox).toHaveAttribute("aria-selected", "true");
    expect(outbox).toHaveAttribute("aria-selected", "false");
  });

  it("threadDetail prop pre-selects that thread + renders its body (test 33)", () => {
    const threadA = makeThread({
      contactId: "contact-a",
      contactName: "Deep LinkA",
      lastMessageBody: "thread A body",
    });
    const threadB = makeThread({
      contactId: "contact-b",
      contactName: "Deep LinkB",
      lastMessageBody: "thread B body",
    });

    render(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        threads={[threadA, threadB]}
        threadDetail={makeDetail("contact-b", "thread B body")}
      />,
    );

    const panel = screen.getByTestId("inbox-detail-panel");
    expect(panel).toHaveTextContent("thread B body");
    expect(panel).not.toHaveTextContent("thread A body");

    expect(screen.getByTestId("inbox-thread-contact-b")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(screen.getByTestId("inbox-thread-contact-a")).not.toHaveAttribute(
      "data-selected",
    );
  });
});
