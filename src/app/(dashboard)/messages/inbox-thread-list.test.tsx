import { describe, expect, it } from "vitest";

import type { Thread } from "@/lib/messages/list-threads";

import { applyThreadUpdates, type ThreadUpdate } from "./inbox-thread-list";

function makeThread(overrides: Partial<Thread> & { threadId: string }): Thread {
  return {
    conversationId: null,
    contactId: `contact-${overrides.threadId}`,
    contactName: null,
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
  };
}

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
