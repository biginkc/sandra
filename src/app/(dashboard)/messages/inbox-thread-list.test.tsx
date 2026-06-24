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
