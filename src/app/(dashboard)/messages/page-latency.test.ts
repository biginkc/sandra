import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canonicalizeThreadId: vi.fn(),
  createAdminClient: vi.fn(),
  createClient: vi.fn(),
  fetchInboxDetail: vi.fn(),
  getQueueStats: vi.fn(),
  getUserById: vi.fn(),
  listQueuedPage: vi.fn(),
  listThreadPage: vi.fn(),
  listUnknownSenders: vi.fn(),
  markMessagesReadForThread: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

vi.mock("@/lib/messages/list-threads", () => ({
  listThreadPage: mocks.listThreadPage,
}));

vi.mock("@/lib/messages/list-unknown-senders", () => ({
  listUnknownSenders: mocks.listUnknownSenders,
}));

vi.mock("@/lib/messages/threading", () => ({
  canonicalizeThreadId: mocks.canonicalizeThreadId,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("../leads/actions", () => ({
  markMessagesReadForThread: mocks.markMessagesReadForThread,
}));

vi.mock("./actions", () => ({
  getQueueStats: mocks.getQueueStats,
  listQueuedPage: mocks.listQueuedPage,
}));

vi.mock("./inbox-detail-data", () => ({
  fetchInboxDetail: mocks.fetchInboxDetail,
}));

vi.mock("./cockpit-view", () => ({
  CockpitView: () => null,
}));

import MessagesPage from "./page";

const EMPTY_COUNTS = {
  all: 0,
  mine: 0,
  unassigned: 0,
  unread: 0,
  escalated: 0,
  dispo: 0,
  needs_outcome: 0,
};

describe("MessagesPage latency boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "current-user" } },
        })),
      },
    });
    mocks.createAdminClient.mockReturnValue({
      auth: { admin: { getUserById: mocks.getUserById } },
    });
    mocks.getUserById.mockResolvedValue({
      data: { user: { id: "assigned-user", email: "assigned@example.test" } },
    });
    mocks.listThreadPage.mockResolvedValue({
      threads: [],
      counts: EMPTY_COUNTS,
      total: 0,
      hiddenCount: 0,
      page: 1,
      pageSize: 200,
    });
    mocks.listQueuedPage.mockResolvedValue({
      ok: true,
      data: { rows: [{ id: "queued-row" }], hasMore: true },
    });
    mocks.getQueueStats.mockResolvedValue({
      ok: true,
      data: {
        queued: 1,
        paused: 0,
        sentOutToday: 0,
        failedToday: 0,
        nextScheduledFor: null,
        lastScheduledFor: null,
      },
    });
    mocks.listUnknownSenders.mockResolvedValue([]);
    mocks.canonicalizeThreadId.mockResolvedValue("conversation-1");
    mocks.fetchInboxDetail.mockResolvedValue(null);
  });

  it("does not load queued rows or the Auth directory for list-only Inbox views", async () => {
    const element = (await MessagesPage({
      searchParams: Promise.resolve({ filter: "unread" }),
    })) as ReactElement<{
      queued: unknown[];
      queuedHasMore: boolean;
      queueStats: { queued: number };
    }>;

    expect(mocks.listQueuedPage).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(element.props.queued).toEqual([]);
    expect(element.props.queuedHasMore).toBe(false);
    expect(element.props.queueStats.queued).toBe(1);
  });

  it("loads queued rows only when the Outbox tab is active", async () => {
    const element = (await MessagesPage({
      searchParams: Promise.resolve({ tab: "outbox" }),
    })) as ReactElement<{ queued: Array<{ id: string }>; queuedHasMore: boolean }>;

    expect(mocks.listQueuedPage).toHaveBeenCalledOnce();
    expect(element.props.queued).toEqual([{ id: "queued-row" }]);
    expect(element.props.queuedHasMore).toBe(true);
  });

  it("resolves only the selected detail assignee", async () => {
    mocks.fetchInboxDetail.mockResolvedValue({
      threadId: "conversation-1",
      assigneeId: "assigned-user",
    });

    const element = (await MessagesPage({
      searchParams: Promise.resolve({ thread: "conversation-1" }),
    })) as ReactElement<{ assigneeEmails: Record<string, string> }>;

    expect(mocks.getUserById).toHaveBeenCalledOnce();
    expect(mocks.getUserById).toHaveBeenCalledWith("assigned-user");
    expect(element.props.assigneeEmails).toEqual({
      "assigned-user": "assigned@example.test",
    });
    expect(mocks.markMessagesReadForThread).toHaveBeenCalledWith(
      "conversation-1",
    );
  });
});
