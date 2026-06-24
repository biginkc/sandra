import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Thread } from "@/lib/messages/list-threads";

import {
  applyThreadUpdates,
  InboxThreadList,
  type ThreadUpdate,
} from "./inbox-thread-list";

const supabaseMock = vi.hoisted(() => {
  const subscriptions: Array<{
    type: string;
    filter: Record<string, unknown>;
    callback: () => void;
  }> = [];
  const channel = {
    on: vi.fn(
      (
        type: string,
        filter: Record<string, unknown>,
        callback: () => void,
      ) => {
        subscriptions.push({ type, filter, callback });
        return channel;
      },
    ),
    subscribe: vi.fn(() => channel),
  };
  return {
    subscriptions,
    channel,
    client: {
      auth: {
        getSession: vi.fn(async () => ({ data: { session: null } })),
      },
      realtime: { setAuth: vi.fn() },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
    },
  };
});

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => supabaseMock.client,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

function makeThread(overrides: Partial<Thread> & { threadId: string }): Thread {
  return {
    contactId: `contact-${overrides.threadId}`,
    contactName: null,
    threadCustomerPhone: null,
    threadBusinessPhone: null,
    contactPhone: null,
    propertyId: null,
    propertyAddress: null,
    assigneeId: null,
    lastMessageBody: "x",
    lastMessageDirection: "inbound",
    lastMessageAt: "2026-06-12T00:00:00.000Z",
    unreadCount: 0,
    needsHumanAttention: false,
    escalationReason: null,
    isOptedOut: false,
    isTestTraffic: false,
    ...overrides,
    propertyStatus: overrides.propertyStatus ?? null,
    outreachDispo: overrides.outreachDispo ?? null,
    needsOutcome: overrides.needsOutcome ?? false,
    aiResponderStatus: overrides.aiResponderStatus ?? null,
    aiResponderReason: overrides.aiResponderReason ?? null,
    aiResponderStatusAt: overrides.aiResponderStatusAt ?? null,
    aiLastDeliveryStatus: overrides.aiLastDeliveryStatus ?? null,
    aiLastDeliveryError: overrides.aiLastDeliveryError ?? null,
  };
}

beforeEach(() => {
  supabaseMock.subscriptions.length = 0;
  supabaseMock.channel.on.mockClear();
  supabaseMock.channel.subscribe.mockClear();
  supabaseMock.client.channel.mockClear();
  supabaseMock.client.removeChannel.mockClear();
  supabaseMock.client.auth.getSession.mockClear();
  supabaseMock.client.realtime.setAuth.mockClear();
});

/**
 * Client-side realtime re-sort — must stay order-aligned with the server
 * sort in `listThreads` (recency-only). PR #268 retired unread-first
 * bubbling; these lock the client path so a refresh never reshuffles
 * rows based on read state.
 */
describe("applyThreadUpdates — recency-only ordering", () => {
  const base = [
    makeThread({
      threadId: "t-new",
      lastMessageAt: "2026-06-12T12:00:00.000Z",
    }),
    makeThread({
      threadId: "t-mid",
      lastMessageAt: "2026-06-12T08:00:00.000Z",
      unreadCount: 0,
    }),
    makeThread({
      threadId: "t-old",
      lastMessageAt: "2026-06-12T01:00:00.000Z",
    }),
  ];

  it("an unread-count-only change never reorders rows", () => {
    // Simulates read-on-open / badge churn arriving via realtime: the
    // middle thread gains unread, but its last message is unchanged.
    const updates: Record<string, ThreadUpdate> = {
      "t-mid": {
        lastMessageBody: "x",
        lastMessageDirection: "inbound",
        lastMessageAt: "2026-06-12T08:00:00.000Z",
        threadCustomerPhone: null,
        threadBusinessPhone: null,
        unreadDelta: 3,
      },
    };

    const next = applyThreadUpdates(base, updates);
    expect(next.map((t) => t.threadId)).toEqual(["t-new", "t-mid", "t-old"]);
    expect(next[1].unreadCount).toBe(3);
  });

  it("only a newer message moves a row — straight to its recency slot", () => {
    const updates: Record<string, ThreadUpdate> = {
      "t-old": {
        lastMessageBody: "fresh inbound",
        lastMessageDirection: "inbound",
        lastMessageAt: "2026-06-12T13:00:00.000Z",
        threadCustomerPhone: "+15551230000",
        threadBusinessPhone: "+18162804181",
        unreadDelta: 1,
      },
    };

    const next = applyThreadUpdates(base, updates);
    expect(next.map((t) => t.threadId)).toEqual(["t-old", "t-new", "t-mid"]);
  });

  it("no updates returns the server order untouched", () => {
    expect(applyThreadUpdates(base, {})).toBe(base);
  });
});

describe("<InboxThreadList /> realtime subscriptions", () => {
  it("shows the active thread phone in the row before the thread is opened", () => {
    render(
      <InboxThreadList
        initial={[
          makeThread({
            threadId: "visible-phone",
            contactName: "Casey Contact",
            threadCustomerPhone: "+15550000002",
            threadBusinessPhone: "+18162804181",
            contactPhone: "+15550000002",
            propertyAddress: null,
          }),
        ]}
        selectedThreadId={null}
        currentUserId={null}
        onSelectThread={vi.fn()}
      />,
    );

    expect(screen.getByTestId("inbox-thread-visible-phone-phone")).toHaveTextContent(
      "+1 (555) 000-0002",
    );
  });

  it("refreshes on message_threads changes so Sandra delivery state does not stay stale", async () => {
    render(
      <InboxThreadList
        initial={[]}
        selectedThreadId={null}
        currentUserId={null}
        onSelectThread={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(supabaseMock.client.channel).toHaveBeenCalledWith(
        "cockpit:thread-list",
      );
    });

    expect(supabaseMock.subscriptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "postgres_changes",
          filter: {
            event: "*",
            schema: "public",
            table: "message_threads",
          },
        }),
      ]),
    );
  });
});

describe("<InboxThreadList /> Sandra state", () => {
  it.each([
    ["wrong_number", "Wrong #"],
    ["bad_number", "Bad #"],
    ["not_interested", "Not interested"],
    ["needs_sequence", "Needs sequence"],
    ["opted_out", "Opted out"],
    ["dnc", "DNC"],
    ["nurture", "Follow up"],
    ["callback_requested", "Callback"],
  ])("shows compact disposition label %s beside the contact name", (dispo, label) => {
    const { getByTestId, getByText } = render(
      <InboxThreadList
        initial={[
          makeThread({
            threadId: `thread-with-${dispo}`,
            contactName: "David Moreno",
            outreachDispo: dispo,
            lastMessageBody: "Latest reply",
          }),
        ]}
        selectedThreadId={null}
        currentUserId={null}
        onSelectThread={vi.fn()}
      />,
    );

    const name = getByText("David Moreno");
    const disposition = getByTestId(`inbox-thread-thread-with-${dispo}-disposition`);

    expect(disposition).toHaveTextContent(label);
    expect(disposition).toHaveAttribute("title", label);
    expect(disposition.parentElement).toBe(name.parentElement);
    expect(disposition).toHaveClass("max-w-[7.5rem]");
    expect(disposition).toHaveClass("truncate");
  });

  it("does not render a disposition pill when the thread has no disposition", () => {
    render(
      <InboxThreadList
        initial={[
          makeThread({
            threadId: "thread-without-dispo",
            contactName: "Open Lead",
            outreachDispo: null,
          }),
        ]}
        selectedThreadId={null}
        currentUserId={null}
        onSelectThread={vi.fn()}
      />,
    );

    expect(
      screen.queryByTestId("inbox-thread-thread-without-dispo-disposition"),
    ).not.toBeInTheDocument();
  });

  it("places the Sandra icon inline between the avatar and address metadata", () => {
    const { getByTestId } = render(
      <InboxThreadList
        initial={[
          makeThread({
            threadId: "thread-ai-inline",
            contactName: "Inline Lead",
            propertyAddress: "449 Example Ave",
            threadCustomerPhone: "+18165550123",
            aiResponderStatus: "handled",
            aiLastDeliveryStatus: "delivered",
          }),
        ]}
        selectedThreadId={null}
        currentUserId={null}
        onSelectThread={vi.fn()}
      />,
    );

    const avatar = getByTestId("inbox-thread-thread-ai-inline-avatar");
    const status = getByTestId("inbox-thread-thread-ai-inline-sandra-status");
    const phone = getByTestId("inbox-thread-thread-ai-inline-phone");
    const rowChildren = Array.from(status.parentElement?.children ?? []);

    expect(status.parentElement).toBe(avatar.parentElement);
    expect(status.parentElement).toBe(phone.parentElement);
    expect(rowChildren.indexOf(status)).toBe(rowChildren.indexOf(avatar) + 1);
    expect(status).toHaveAccessibleName("Sandra handled. SMS delivered");
    expect(status).not.toHaveClass("rounded-full");
    expect(status).not.toHaveClass("border");
    expect(getByTestId("inbox-thread-thread-ai-inline-sandra-status-dot")).toHaveClass(
      "bg-[#10b981]",
    );
  });

  it("keeps Sandra's escalation reason in the icon label only", () => {
    const { getByTestId } = render(
      <InboxThreadList
        initial={[
          makeThread({
            threadId: "thread-ai-escalated",
            contactName: "AI Lead",
            aiResponderStatus: "escalated",
            aiResponderReason: "asked for price",
            needsHumanAttention: false,
            escalationReason: null,
          }),
        ]}
        selectedThreadId={null}
        currentUserId={null}
        onSelectThread={vi.fn()}
      />,
    );

    const status = getByTestId("inbox-thread-thread-ai-escalated-sandra-status");
    expect(status).not.toHaveTextContent("Sandra escalated");
    expect(status).not.toHaveTextContent("asked for price");
    expect(status).toHaveAccessibleName("Sandra escalated: asked for price");
    expect(status).not.toHaveClass("bg-[#fff7ed]");
    expect(status).not.toHaveClass("border-[#fed7aa]");
    expect(
      getByTestId("inbox-thread-thread-ai-escalated-sandra-status-dot"),
    ).toHaveClass("bg-[#f59e0b]");
    expect(
      screen.queryByTestId("inbox-thread-thread-ai-escalated-sandra-reason"),
    ).not.toBeInTheDocument();
  });
});
