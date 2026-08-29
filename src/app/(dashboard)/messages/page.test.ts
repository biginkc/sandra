import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Thread } from "@/lib/messages/list-threads";

const mocks = vi.hoisted(() => ({
  listThreads: vi.fn(),
  effectivePage: null as number | null,
  listQueuedPage: vi.fn(),
  getQueueStats: vi.fn(),
  listUnknownSenders: vi.fn(),
  fetchInboxDetail: vi.fn(),
  markMessagesReadForThread: vi.fn(),
  canonicalizeThreadId: vi.fn(),
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

vi.mock("@/lib/messages/list-threads", () => ({
  listThreadPage: async (...args: unknown[]) => {
    const rows = (await mocks.listThreads(...args)) as Thread[];
    const opts = args[1] as {
      filter: string;
      currentUserId: string | null;
      hideNoise: boolean;
      page: number;
    };
    const visible = opts.hideNoise
      ? rows.filter(
          (row) => !row.isDncLocked && !row.isOptedOut && !row.isTestTraffic,
        )
      : rows;
    const dispoVisible = rows.filter((row) => !row.isTestTraffic);
    const activeRows = opts.filter === "dispo" ? dispoVisible : visible;
    const isActualLead = (row: Thread) =>
      row.propertyStatus !== null && row.propertyStatus !== "prospect";
    const filtered = activeRows.filter((row) => {
      if (opts.filter === "mine")
        return isActualLead(row) && row.assigneeId === opts.currentUserId;
      if (opts.filter === "unassigned")
        return isActualLead(row) && row.assigneeId === null;
      if (opts.filter === "unread") return row.unreadCount > 0;
      if (opts.filter === "escalated")
        return row.aiResponderStatus === "escalated";
      if (opts.filter === "dispo") return row.aiDispositionReview !== null;
      if (opts.filter === "needs_outcome") return row.needsOutcome;
      return true;
    });
    return {
      threads: filtered,
      counts: {
        all: visible.length,
        mine: opts.currentUserId
          ? visible.filter(
              (row) =>
                isActualLead(row) && row.assigneeId === opts.currentUserId,
            ).length
          : 0,
        unassigned: opts.currentUserId
          ? visible.filter(
              (row) => isActualLead(row) && row.assigneeId === null,
            ).length
          : 0,
        unread: visible.filter((row) => row.unreadCount > 0).length,
        escalated: visible.filter(
          (row) => row.aiResponderStatus === "escalated",
        ).length,
        dispo: dispoVisible.filter((row) => row.aiDispositionReview !== null)
          .length,
        needs_outcome: visible.filter((row) => row.needsOutcome).length,
      },
      total: filtered.length,
      hiddenCount:
        opts.filter === "dispo"
          ? rows.filter((row) => row.aiDispositionReview !== null).length -
            filtered.length
          : rows.length - visible.length,
      page: mocks.effectivePage ?? opts.page,
      pageSize: 200,
    };
  },
}));

vi.mock("@/lib/messages/list-unknown-senders", () => ({
  listUnknownSenders: mocks.listUnknownSenders,
}));

vi.mock("@/lib/messages/threading", () => ({
  canonicalizeThreadId: mocks.canonicalizeThreadId,
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
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
    threadCustomerPhone: overrides.threadCustomerPhone ?? null,
    threadBusinessPhone: overrides.threadBusinessPhone ?? null,
    contactPhone: overrides.contactPhone ?? null,
    propertyId: overrides.propertyId ?? `property-${overrides.threadId}`,
    propertyAddress: overrides.propertyAddress ?? null,
    propertyStatus: overrides.propertyStatus ?? "prospect",
    outreachDispo: overrides.outreachDispo ?? null,
    aiDispositionReview: overrides.aiDispositionReview ?? null,
    isDncLocked: overrides.isDncLocked ?? false,
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
    mocks.effectivePage = null;
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
        paused: 0,
        sentOutToday: 0,
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
    })) as ReactElement<{
      threads: Thread[];
      filterCounts: Record<string, number>;
      hiddenDncCount: number;
    }>;

    expect(element.props.threads.map((thread) => thread.threadId)).toEqual([
      "real-needs",
    ]);
    expect(element.props.filterCounts.unread).toBe(1);
    expect(element.props.filterCounts.needs_outcome).toBe(1);
    expect(element.props.hiddenDncCount).toBe(2);
  });

  it("treats Sandra Dispo as pending AI review work, including DNC reviews", async () => {
    mocks.listThreads.mockResolvedValue([
      makeThread({
        threadId: "applied-only",
        outreachDispo: "not_interested",
      }),
      makeThread({
        threadId: "pending-review",
        outreachDispo: "not_interested",
        aiDispositionReview: {
          id: "review-1",
          status: "pending",
          disposition: "not_interested",
          reason: "classified reply",
          sourceInboundMessageId: "message-1",
          createdAt: "2026-08-28T12:00:00Z",
        },
      }),
      makeThread({
        threadId: "pending-dnc",
        outreachDispo: "dnc",
        isOptedOut: true,
        aiDispositionReview: {
          id: "review-2",
          status: "pending",
          disposition: "dnc",
          reason: "stop request",
          sourceInboundMessageId: "message-2",
          createdAt: "2026-08-28T12:01:00Z",
        },
      }),
    ]);

    const element = (await MessagesPage({
      searchParams: Promise.resolve({ filter: "dispo" }),
    })) as ReactElement<{
      filter: string;
      threads: Thread[];
      hiddenDncCount: number;
    }>;

    expect(element.props.filter).toBe("dispo");
    expect(element.props.threads.map((thread) => thread.threadId)).toEqual([
      "pending-review",
      "pending-dnc",
    ]);
    expect(element.props.hiddenDncCount).toBe(0);
  });

  it("redirects a clamped inbox page to the effective page URL", async () => {
    mocks.listThreads.mockResolvedValue([]);
    mocks.effectivePage = 2;

    await expect(
      MessagesPage({
        searchParams: Promise.resolve({
          filter: "unassigned",
          inboxPage: "999999",
          hideDnc: "0",
        }),
      }),
    ).rejects.toThrow(/^redirect:/);

    const target = mocks.redirect.mock.calls.at(-1)?.[0] as string;
    const redirected = new URL(target, "https://sandra.test");
    expect(redirected.searchParams.get("filter")).toBe("unassigned");
    expect(redirected.searchParams.get("inboxPage")).toBe("2");
    expect(redirected.searchParams.get("hideDnc")).toBe("0");
  });

  it("does not canonicalize irrelevant inbox pagination while Outbox is active", async () => {
    mocks.listThreads.mockResolvedValue([]);
    mocks.effectivePage = 2;

    const element = (await MessagesPage({
      searchParams: Promise.resolve({
        tab: "outbox",
        inboxPage: "999999",
      }),
    })) as ReactElement<{ activeTab: string }>;

    expect(element.props.activeTab).toBe("outbox");
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.listThreads).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ page: 1 }),
    );
  });

  it.each(["unknown", "dismissed"] as const)(
    "ignores irrelevant inbox pagination for the %s sender bucket",
    async (filter) => {
      mocks.listThreads.mockResolvedValue([]);

      await MessagesPage({
        searchParams: Promise.resolve({ filter, inboxPage: "999999" }),
      });

      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(mocks.listThreads).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ page: 1 }),
      );
    },
  );

  it("redirects legacy handled filter links to the canonical Dispo URL", async () => {
    await expect(
      MessagesPage({
        searchParams: Promise.resolve({
          tab: "inbox",
          thread: "conv-1",
          filter: "handled",
          hideDnc: "0",
          preserved: "yes",
        }),
      }),
    ).rejects.toThrow(/^redirect:/);
    const target = mocks.redirect.mock.calls.at(-1)?.[0] as string;
    const redirected = new URL(target, "https://sandra.test");
    expect(redirected.pathname).toBe("/messages");
    expect(redirected.searchParams.get("tab")).toBe("inbox");
    expect(redirected.searchParams.get("thread")).toBe("conv-1");
    expect(redirected.searchParams.get("filter")).toBe("dispo");
    expect(redirected.searchParams.get("hideDnc")).toBe("0");
    expect(redirected.searchParams.get("preserved")).toBe("yes");
    expect(redirected.search).not.toContain("filter=handled");
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("normalizes signed-out Mine and Unassigned filters to All counts", async () => {
    mocks.createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: null } })),
      },
    });
    mocks.listThreads.mockResolvedValue([
      makeThread({ threadId: "mine", assigneeId: "user-1" }),
      makeThread({ threadId: "unassigned", assigneeId: null }),
    ]);

    for (const filter of ["mine", "unassigned"] as const) {
      const element = (await MessagesPage({
        searchParams: Promise.resolve({ filter }),
      })) as ReactElement<{
        filter: string;
        threads: Thread[];
        filterCounts: Record<string, number>;
      }>;

      expect(element.props.filter).toBe("all");
      expect(element.props.threads.map((thread) => thread.threadId)).toEqual([
        "mine",
        "unassigned",
      ]);
      expect(element.props.filterCounts.all).toBe(2);
      expect(element.props.filterCounts.mine).toBe(0);
      expect(element.props.filterCounts.unassigned).toBe(0);
    }
  });

  it("passes Unknown and Dismissed sender-bucket counts separately", async () => {
    mocks.listThreads.mockResolvedValue([]);
    mocks.listUnknownSenders.mockResolvedValue([
      {
        fromAddress: "+15550000001",
        toAddress: null,
        latestBody: "dismissed",
        latestAt: "2026-06-24T12:00:00Z",
        messageCount: 1,
        isDismissed: true,
      },
      {
        fromAddress: "+15550000002",
        toAddress: null,
        latestBody: "active",
        latestAt: "2026-06-24T11:00:00Z",
        messageCount: 1,
        isDismissed: false,
      },
    ]);

    const dismissedElement = (await MessagesPage({
      searchParams: Promise.resolve({ filter: "dismissed" }),
    })) as ReactElement<{
      unknownSenders: Array<{ fromAddress: string; isDismissed: boolean }>;
      filterCounts: Record<string, number>;
    }>;

    expect(dismissedElement.props.unknownSenders).toEqual([
      expect.objectContaining({
        fromAddress: "+15550000001",
        isDismissed: true,
      }),
    ]);
    expect(dismissedElement.props.filterCounts.unknown).toBe(1);
    expect(dismissedElement.props.filterCounts.dismissed).toBe(1);

    const unknownElement = (await MessagesPage({
      searchParams: Promise.resolve({ filter: "unknown" }),
    })) as ReactElement<{
      unknownSenders: Array<{ fromAddress: string; isDismissed: boolean }>;
      filterCounts: Record<string, number>;
    }>;

    expect(unknownElement.props.unknownSenders).toEqual([
      expect.objectContaining({
        fromAddress: "+15550000002",
        isDismissed: false,
      }),
    ]);
    expect(mocks.listUnknownSenders).toHaveBeenCalledWith(expect.anything(), {
      includeDismissed: true,
    });
  });

  it("uses one latest-row sender classification for Unknown and Dismissed", async () => {
    mocks.listThreads.mockResolvedValue([]);
    mocks.listUnknownSenders.mockResolvedValue([
      {
        fromAddress: "+15550000001",
        toAddress: null,
        latestBody: "latest dismissed",
        latestAt: "2026-06-24T12:00:00Z",
        messageCount: 2,
        isDismissed: true,
      },
    ]);

    const element = (await MessagesPage({
      searchParams: Promise.resolve({ filter: "unknown" }),
    })) as ReactElement<{
      unknownSenders: Array<{ fromAddress: string; isDismissed: boolean }>;
      filterCounts: Record<string, number>;
    }>;

    expect(element.props.unknownSenders).toEqual([]);
    expect(element.props.filterCounts.unknown).toBe(0);
    expect(element.props.filterCounts.dismissed).toBe(1);
  });

  it("passes queue query failures through instead of presenting fallback rows as empty", async () => {
    mocks.listThreads.mockResolvedValue([]);
    mocks.listQueuedPage.mockResolvedValue({
      ok: false,
      error: { code: "QUEUE_LOAD_FAILED", message: "queue unavailable" },
    });
    mocks.getQueueStats.mockResolvedValue({
      ok: false,
      error: { code: "QUEUE_STATS_FAILED", message: "stats unavailable" },
    });

    const element = (await MessagesPage({
      searchParams: Promise.resolve({ tab: "outbox" }),
    })) as ReactElement<{
      queued: unknown[];
      queueLoadFailed: boolean;
      queueStatsFailed: boolean;
    }>;

    expect(element.props.queued).toEqual([]);
    expect(element.props.queueLoadFailed).toBe(true);
    expect(element.props.queueStatsFailed).toBe(true);
  });
});
