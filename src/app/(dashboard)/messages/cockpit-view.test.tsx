import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CockpitView } from "./cockpit-view";
import type { InboxFilterCounts } from "./inbox-filters";
import type { InboxDetail as InboxDetailData } from "./inbox-detail-data";
import type { Thread } from "@/lib/messages/list-threads";
import type { Database } from "@/lib/supabase/types";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

const navigationMocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  search: "",
}));
const getQueueStatsMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: navigationMocks.push,
    replace: navigationMocks.replace,
    refresh: navigationMocks.refresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(navigationMocks.search),
  usePathname: () => "/messages",
}));

// Server-action modules can't load in jsdom (next/server, supabase server).
vi.mock("./actions", () => ({
  listQueuedPage: vi.fn(async () => ({
    ok: true,
    data: { rows: [], hasMore: false },
  })),
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
  getQueueStats: getQueueStatsMock,
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

function makeThread(
  overrides: Partial<Thread> & { contactId: string },
): Thread {
  const propertyId = overrides.propertyId ?? `prop-${overrides.contactId}`;
  return {
    threadId: overrides.threadId ?? `conv-${overrides.contactId}`,
    contactId: overrides.contactId,
    contactName: overrides.contactName ?? `Contact ${overrides.contactId}`,
    threadCustomerPhone: overrides.threadCustomerPhone ?? "+15551234567",
    threadBusinessPhone: overrides.threadBusinessPhone ?? "+18162804181",
    contactPhone: overrides.contactPhone ?? "+15551234567",
    propertyId,
    propertyAddress: overrides.propertyAddress ?? "123 Main St",
    propertyStatus: overrides.propertyStatus ?? "prospect",
    outreachDispo: overrides.outreachDispo ?? null,
    isDncLocked: overrides.isDncLocked ?? false,
    lastMessageAt: overrides.lastMessageAt ?? "2026-04-29T12:00:00Z",
    lastMessageBody: overrides.lastMessageBody ?? "hello",
    lastMessageDirection: overrides.lastMessageDirection ?? "inbound",
    unreadCount: overrides.unreadCount ?? 0,
    assigneeId: overrides.assigneeId ?? null,
    needsHumanAttention: overrides.needsHumanAttention ?? false,
    escalationReason: overrides.escalationReason ?? null,
    isOptedOut: overrides.isOptedOut ?? false,
    isTestTraffic: overrides.isTestTraffic ?? false,
    needsOutcome: overrides.needsOutcome ?? false,
    aiResponderStatus: overrides.aiResponderStatus ?? null,
    aiResponderReason: overrides.aiResponderReason ?? null,
    aiResponderStatusAt: overrides.aiResponderStatusAt ?? null,
    aiLastDeliveryStatus: overrides.aiLastDeliveryStatus ?? null,
    aiLastDeliveryError: overrides.aiLastDeliveryError ?? null,
  } as Thread;
}

function makeMessage(
  overrides: Partial<MessageRow> & {
    id: string;
    body: string;
    contact_id: string;
    property_id: string;
  },
): MessageRow {
  return {
    id: overrides.id,
    body: overrides.body,
    direction: overrides.direction ?? "inbound",
    status: overrides.status ?? "received",
    channel: "sms",
    contact_id: overrides.contact_id,
    property_id: overrides.property_id,
    conversation_id: overrides.conversation_id ?? null,
    from_address: "+15551234567",
    to_address: "+18162804181",
    created_at: overrides.created_at ?? "2026-04-29T12:00:00Z",
    read_at: null,
    metadata: null,
  } as MessageRow;
}

function makeDetail(contactId: string, body: string): InboxDetailData {
  const propertyId = `prop-${contactId}`;
  return {
    threadId: `conv-${contactId}`,
    conversationId: `conv-${contactId}`,
    contactId,
    contactName: `Contact ${contactId}`,
    threadCustomerPhone: "+15551234567",
    threadBusinessPhone: "+18162804181",
    contactPhone: "+15551234567",
    replyToPhone: "+15551234567",
    propertyId,
    propertyAddress: "123 Main St, Albany, NY",
    homeownerContactId: contactId,
    agentContactId: null,
    assigneeId: null,
    propertyStatus: "prospect",
    outreachDispo: null,
    contactDoNotContact: false,
    contactSmsOptedOut: false,
    isDncLocked: false,
    initialMessages: [
      makeMessage({
        id: `m-${contactId}`,
        body,
        contact_id: contactId,
        property_id: `prop-${contactId}`,
        conversation_id: `conv-${contactId}`,
      }),
    ],
  };
}

const baseProps = {
  filter: "all" as const,
  threads: [],
  queued: [],
  selectedThreadId: null,
  threadDetail: null,
  unknownSenders: [],
  filterCounts: {
    all: 0,
    mine: 0,
    unassigned: 0,
    unknown: 0,
    dismissed: 0,
    unread: 0,
    escalated: 0,
    dispo: 0,
    needs_outcome: 0,
  } satisfies InboxFilterCounts,
  assigneeEmails: {},
  currentUserId: "user-1",
  queueStats: {
    queued: 0,
    paused: 0,
    sentOutToday: 0,
    failedToday: 0,
    nextScheduledFor: null,
    lastScheduledFor: null,
  },
  hideDnc: true,
  hiddenDncCount: 0,
};

describe("<CockpitView /> URL deep-linking", () => {
  beforeEach(() => {
    navigationMocks.push.mockClear();
    navigationMocks.replace.mockClear();
    navigationMocks.refresh.mockClear();
    navigationMocks.search = "";
    getQueueStatsMock.mockReset();
    getQueueStatsMock.mockResolvedValue({
      ok: true,
      data: baseProps.queueStats,
    });
  });

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

  it("Outbox tab shows real queue stats — queued plain, sent green, failed red", () => {
    render(
      <CockpitView
        {...baseProps}
        activeTab="outbox"
        queueStats={{
          ...baseProps.queueStats,
          queued: 8964,
          sentOutToday: 385,
          failedToday: 2,
        }}
      />,
    );

    const stats = screen.getByTestId("tab-outbox-stats");
    const queued = within(stats).getByText("8964");
    const sent = within(stats).getByText("385");
    const failed = within(stats).getByText("2");

    // Queued inherits the tab text color — no status class of its own.
    expect(queued.className).not.toMatch(/emerald|red/);
    expect(sent).toHaveClass("text-emerald-600");
    expect(failed).toHaveClass("text-red-600");
  });

  it("shows unavailable instead of confirmed zero queue totals after first-paint failure", () => {
    render(<CockpitView {...baseProps} activeTab="inbox" queueStatsFailed />);

    expect(
      screen.getByTestId("tab-outbox-stats-unavailable"),
    ).toHaveTextContent("Unavailable");
    expect(screen.queryByTestId("tab-outbox-stats")).toBeNull();
  });

  it("replaces the unavailable queue badge after the automatic poll succeeds", async () => {
    vi.useFakeTimers();
    getQueueStatsMock.mockResolvedValue({
      ok: true,
      data: {
        ...baseProps.queueStats,
        queued: 14,
        sentOutToday: 3,
        failedToday: 1,
      },
    });

    const view = render(
      <CockpitView {...baseProps} activeTab="inbox" queueStatsFailed />,
    );
    try {
      expect(screen.getByTestId("tab-outbox-stats-unavailable")).toBeVisible();

      await act(async () => {
        vi.advanceTimersByTime(30_000);
        await Promise.resolve();
      });

      expect(screen.queryByTestId("tab-outbox-stats-unavailable")).toBeNull();
      expect(screen.getByTestId("tab-outbox-stats")).toHaveTextContent(
        /14\s*·\s*3\s*·\s*1/,
      );
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("inbox grid is viewport-constrained so dispo + reply stay pinned (regression: page-scroll bug)", () => {
    // Regression for the May-5 UX bug: with no height constraint on the grid,
    // the whole page scrolled instead of the messages thread, pushing the
    // dispo bar + reply box off-screen on busy threads. The grid must carry
    // a viewport-relative height so each panel scrolls independently.
    const thread = makeThread({ contactId: "contact-grid" });
    render(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        threads={[thread]}
        threadDetail={makeDetail("contact-grid", "body")}
      />,
    );

    const grid = screen.getByTestId("inbox-cockpit-grid");
    expect(grid.className).toMatch(/md:h-\[calc\(100vh-260px\)\]/);
    expect(grid.className).toMatch(/grid-cols-1/);
    expect(grid.className).toMatch(/md:grid-cols-/);
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

    expect(screen.getByTestId(threadBTestId(threadB.threadId))).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(
      screen.getByTestId(threadBTestId(threadA.threadId)),
    ).not.toHaveAttribute("data-selected");
  });

  it("clears the loading skeleton when the server returns no detail for the selected thread", async () => {
    const threadA = makeThread({
      contactId: "contact-a",
      lastMessageBody: "thread A body",
    });
    const threadB = makeThread({
      contactId: "contact-b",
      lastMessageBody: "thread B body",
    });

    const view = render(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        threads={[threadA, threadB]}
        selectedThreadId={threadA.threadId}
        threadDetail={makeDetail("contact-a", "thread A body")}
      />,
    );

    fireEvent.click(screen.getByTestId(threadBTestId(threadB.threadId)));
    expect(screen.getByTestId("inbox-detail-loading")).toBeInTheDocument();

    view.rerender(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        threads={[threadA, threadB]}
        selectedThreadId={threadB.threadId}
        threadDetail={null}
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByTestId("inbox-detail-loading"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("inbox-detail-empty")).toBeVisible();
  });

  it("uses a real narrow list-or-detail flow without compressing both panes", () => {
    navigationMocks.search = "filter=mine&hideDnc=0";
    const thread = makeThread({ contactId: "mobile-thread" });

    render(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        filter="mine"
        threads={[thread]}
      />,
    );

    expect(screen.getByTestId("inbox-list-view")).toHaveClass("block");
    expect(screen.getByTestId("inbox-detail-view")).toHaveClass("hidden");

    fireEvent.click(screen.getByTestId(threadBTestId(thread.threadId)));

    expect(screen.getByTestId("inbox-list-view")).toHaveClass("hidden");
    expect(screen.getByTestId("inbox-detail-view")).toHaveClass("block");
    expect(navigationMocks.replace).toHaveBeenCalledWith(
      `/messages?filter=mine&hideDnc=0&thread=${thread.threadId}`,
      { scroll: false },
    );
  });

  it("Back preserves URL context and returns focus to the selected row", async () => {
    navigationMocks.search =
      "tab=inbox&filter=unread&hideDnc=0&thread=conv-focus-thread";
    const thread = makeThread({
      contactId: "focus-thread",
      threadId: "conv-focus-thread",
    });

    render(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        filter="unread"
        threads={[thread]}
        selectedThreadId={thread.threadId}
        threadDetail={makeDetail("focus-thread", "open detail")}
      />,
    );

    expect(screen.getByTestId(threadBTestId(thread.threadId))).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "All conversations" }));

    expect(navigationMocks.replace).toHaveBeenCalledWith(
      "/messages?tab=inbox&filter=unread&hideDnc=0",
      { scroll: false },
    );
    expect(navigationMocks.refresh).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId(threadBTestId(thread.threadId))).toHaveFocus();
    });
  });

  it("lets a narrow stale thread URL return focus to the preserved conversation list", async () => {
    navigationMocks.search =
      "tab=inbox&filter=unread&hideDnc=0&thread=missing-thread";
    const thread = makeThread({ contactId: "still-visible" });

    render(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        filter="unread"
        threads={[thread]}
        selectedThreadId="missing-thread"
        threadDetail={null}
      />,
    );

    expect(screen.getByTestId("inbox-list-view")).toHaveClass("hidden");
    expect(screen.getByTestId("inbox-detail-empty")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All conversations" }));

    expect(screen.getByTestId("inbox-list-view")).toHaveClass("block");
    expect(navigationMocks.replace).toHaveBeenCalledWith(
      "/messages?tab=inbox&filter=unread&hideDnc=0",
      { scroll: false },
    );
    await waitFor(() => {
      expect(screen.getByTestId(threadBTestId(thread.threadId))).toHaveFocus();
    });
  });

  it("returns stale-thread focus to a filtered empty-list status", async () => {
    navigationMocks.search = "filter=escalated&thread=missing-thread";

    render(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        filter="escalated"
        selectedThreadId="missing-thread"
        threadDetail={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "All conversations" }));

    await waitFor(() => {
      expect(screen.getByTestId("inbox-empty")).toHaveFocus();
    });
    expect(navigationMocks.replace).toHaveBeenCalledWith(
      "/messages?filter=escalated",
      { scroll: false },
    );
  });

  it("labels a filtered empty view without claiming the Inbox is empty", () => {
    render(
      <CockpitView
        {...baseProps}
        activeTab="inbox"
        filter="escalated"
        hiddenDncCount={2}
      />,
    );

    expect(screen.getByTestId("inbox-empty")).toHaveTextContent(
      "No conversations under this filter. 2 restricted or test threads are hidden.",
    );
    expect(screen.getByTestId("inbox-empty")).not.toHaveTextContent(
      "No conversations yet",
    );
  });
});

function threadBTestId(threadId: string): string {
  return `inbox-thread-${threadId}`;
}
