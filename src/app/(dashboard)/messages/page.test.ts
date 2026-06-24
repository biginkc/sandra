import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Thread } from "@/lib/messages/list-threads";

const mocks = vi.hoisted(() => ({
  listThreads: vi.fn(),
  listQueuedPage: vi.fn(),
  getQueueStats: vi.fn(),
  listUnknownSenders: vi.fn(),
  fetchInboxDetail: vi.fn(),
  markMessagesReadForThread: vi.fn(),
  canonicalizeThreadId: vi.fn(),
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

vi.mock("@/lib/messages/list-threads", () => ({
  listThreads: mocks.listThreads,
}));

vi.mock("@/lib/messages/list-unknown-senders", () => ({
  listUnknownSenders: mocks.listUnknownSenders,
}));

vi.mock("@/lib/messages/threading", () => ({
  canonicalizeThreadId: mocks.canonicalizeThreadId,
}));

vi.mock("../leads/actions", () => ({
  markMessagesReadForThread: mocks.markMessagesReadForThread,
}));

vi.mock("./actions", () => ({
  listQueuedPage: mocks.listQueuedPage,
  getQueueStats: mocks.getQueueStats,
}));

vi.mock("./inbox-detail-data", () => ({
  fetchInboxDetail: mocks.fetchInboxDetail,
}));

vi.mock("./cockpit-view", () => ({
  CockpitView: () => null,
}));

import MessagesPage from "./page";

function makeThread(overrides: Partial<Thread> & { threadId: string }): Thread {
  return {
    threadId: overrides.threadId,
    contactId: overrides.contactId ?? `contact-${overrides.threadId}`,
    contactName: overrides.contactName ?? null,
    contactPhone: overrides.contactPhone ?? null,
    propertyId: overrides.propertyId ?? `property-${overrides.threadId}`,
    propertyAddress: overrides.propertyAddress ?? null,
    propertyStatus: overrides.propertyStatus ?? "prospect",
    outreachDispo: overrides.outreachDispo ?? null,
    assigneeId: overrides.assigneeId ?? null,
    lastMessageBody: overrides.lastMessageBody ?? "body",
    lastMessageDirection: overrides.lastMessageDirection ?? "inbound",
    lastMessageAt: overrides.lastMessageAt ?? "2026-06-19T12:00:00Z",
    unreadCount: overrides.unreadCount ?? 0,
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
  };
}

describe("MessagesPage filter-count boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "user-1" } },
        })),
      },
    });
    mocks.createAdminClient.mockReturnValue({
      auth: {
        admin: {
          listUsers: vi.fn(async () => ({ data: { users: [] } })),
        },
      },
    });
    mocks.listQueuedPage.mockResolvedValue({
      ok: true,
      data: { rows: [], hasMore: false },
    });
    mocks.getQueueStats.mockResolvedValue({
      ok: true,
      data: {
        queued: 0,
        sentToday: 0,
        failedToday: 0,
        nextScheduledFor: null,
        lastScheduledFor: null,
      },
    });
    mocks.listUnknownSenders.mockResolvedValue([]);
    mocks.fetchInboxDetail.mockResolvedValue(null);
    mocks.canonicalizeThreadId.mockResolvedValue(null);
  });

  it("passes counts and threads from the same visible non-noise inbox set", async () => {
    mocks.listThreads.mockResolvedValue([
      makeThread({
        threadId: "real-needs",
        needsOutcome: true,
        unreadCount: 1,
      }),
      makeThread({
        threadId: "real-read",
      }),
      makeThread({
        threadId: "hidden-dnc",
        needsOutcome: true,
        unreadCount: 2,
        isOptedOut: true,
      }),
      makeThread({
        threadId: "hidden-test",
        needsOutcome: true,
        unreadCount: 3,
        isTestTraffic: true,
      }),
    ]);

    const element = (await MessagesPage({
      searchParams: Promise.resolve({ filter: "needs_outcome" }),
    })) as ReactElement<{ threads: Thread[]; unreadCount: number; needsOutcomeCount: number; hiddenDncCount: number }>;

    expect(element.props.threads.map((thread) => thread.threadId)).toEqual([
      "real-needs",
    ]);
    expect(element.props.unreadCount).toBe(1);
    expect(element.props.needsOutcomeCount).toBe(1);
    expect(element.props.hiddenDncCount).toBe(2);
  });
});
