import { describe, expect, it } from "vitest";

import type { Thread } from "@/lib/messages/list-threads";

import {
  applyInboxThreadFilter,
  buildThreadOpts,
  isThreadFilter,
  parseInboxFilter,
  resolveVisibleThreadState,
} from "./inbox-filter-resolve";

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
  };
}

describe("parseInboxFilter", () => {
  it("maps each known ?filter= value to itself", () => {
    for (const f of [
      "unknown",
      "dismissed",
      "mine",
      "unassigned",
      "unread",
      "escalated",
      "needs_outcome",
    ] as const) {
      expect(parseInboxFilter(f)).toBe(f);
    }
  });

  it("defaults to 'all' for absent, empty, or unrecognized values", () => {
    expect(parseInboxFilter(undefined)).toBe("all");
    expect(parseInboxFilter("")).toBe("all");
    expect(parseInboxFilter("all")).toBe("all");
    expect(parseInboxFilter("bogus")).toBe("all");
    expect(parseInboxFilter("ESCALATED")).toBe("all"); // case-sensitive
  });
});

describe("isThreadFilter", () => {
  it("treats thread-list filters (incl. escalated) as thread filters", () => {
    for (const f of [
      "all",
      "mine",
      "unassigned",
      "unread",
      "escalated",
      "needs_outcome",
    ] as const) {
      expect(isThreadFilter(f)).toBe(true);
    }
  });

  it("treats the unknown-bucket filters as non-thread filters", () => {
    expect(isThreadFilter("unknown")).toBe(false);
    expect(isThreadFilter("dismissed")).toBe(false);
  });
});

describe("buildThreadOpts", () => {
  const ctx = { currentUserId: "user-1", canonicalThreadId: "conv-9" };

  it("maps escalated → escalatedOnly and nothing else", () => {
    expect(buildThreadOpts("escalated", ctx)).toEqual({ escalatedOnly: true });
  });

  it("maps mine → assigneeId from the current user", () => {
    expect(buildThreadOpts("mine", ctx)).toEqual({ assigneeId: "user-1" });
  });

  it("drops the mine scope when signed out (no current user)", () => {
    expect(
      buildThreadOpts("mine", { currentUserId: null, canonicalThreadId: null }),
    ).toEqual({});
  });

  it("maps unassigned → unassignedOnly", () => {
    expect(buildThreadOpts("unassigned", ctx)).toEqual({
      unassignedOnly: true,
    });
  });

  it("maps unread → unreadOnly and pins the open thread", () => {
    expect(buildThreadOpts("unread", ctx)).toEqual({
      unreadOnly: true,
      includeThreadId: "conv-9",
    });
  });

  it("omits the unread pin when there is no open thread", () => {
    expect(
      buildThreadOpts("unread", {
        currentUserId: "user-1",
        canonicalThreadId: null,
      }),
    ).toEqual({ unreadOnly: true });
  });

  it("returns empty opts for all / unknown / dismissed (no server-side scoping)", () => {
    expect(buildThreadOpts("all", ctx)).toEqual({});
    expect(buildThreadOpts("unknown", ctx)).toEqual({});
    expect(buildThreadOpts("dismissed", ctx)).toEqual({});
  });

  it("maps needs_outcome → needsOutcomeOnly", () => {
    expect(buildThreadOpts("needs_outcome", ctx)).toEqual({
      needsOutcomeOnly: true,
    });
  });

  it("never sets escalatedOnly for non-escalated filters", () => {
    for (const f of [
      "all",
      "mine",
      "unassigned",
      "unread",
      "needs_outcome",
      "unknown",
      "dismissed",
    ] as const) {
      expect(buildThreadOpts(f, ctx).escalatedOnly).toBeUndefined();
    }
  });
});

describe("applyInboxThreadFilter", () => {
  const threads = [
    makeThread({ threadId: "mine", assigneeId: "user-1" }),
    makeThread({ threadId: "other", assigneeId: "user-2" }),
    makeThread({ threadId: "open", assigneeId: null }),
    makeThread({ threadId: "unread", unreadCount: 2 }),
    makeThread({ threadId: "escalated", needsHumanAttention: true }),
    makeThread({ threadId: "needs", needsOutcome: true }),
  ];

  it("applies each thread-list filter from the same in-memory thread set", () => {
    const ctx = { currentUserId: "user-1", canonicalThreadId: null };

    expect(applyInboxThreadFilter(threads, "mine", ctx).map((t) => t.threadId)).toEqual([
      "mine",
    ]);
    expect(
      applyInboxThreadFilter(threads, "unassigned", ctx).map((t) => t.threadId),
    ).toEqual(["open", "unread", "escalated", "needs"]);
    expect(applyInboxThreadFilter(threads, "unread", ctx).map((t) => t.threadId)).toEqual([
      "unread",
    ]);
    expect(
      applyInboxThreadFilter(threads, "escalated", ctx).map((t) => t.threadId),
    ).toEqual(["escalated"]);
    expect(
      applyInboxThreadFilter(threads, "needs_outcome", ctx).map(
        (t) => t.threadId,
      ),
    ).toEqual(["needs"]);
  });

  it("pins the open read thread only in the active unread list", () => {
    expect(
      applyInboxThreadFilter(threads, "unread", {
        currentUserId: "user-1",
        canonicalThreadId: "mine",
      }).map((thread) => thread.threadId),
    ).toEqual(["mine", "unread"]);
  });
});

describe("resolveVisibleThreadState", () => {
  it("keeps Needs Outcome and Unread badge counts aligned with the visible non-noise set", () => {
    const threads = [
      makeThread({
        threadId: "real-needs",
        needsOutcome: true,
        unreadCount: 1,
      }),
      makeThread({
        threadId: "dnc-needs",
        needsOutcome: true,
        unreadCount: 3,
        isOptedOut: true,
      }),
      makeThread({
        threadId: "test-needs",
        needsOutcome: true,
        unreadCount: 2,
        isTestTraffic: true,
      }),
      makeThread({ threadId: "clean-read" }),
    ];

    const state = resolveVisibleThreadState(threads, "needs_outcome", {
      currentUserId: "user-1",
      canonicalThreadId: null,
      hideDnc: true,
    });

    expect(state.threads.map((thread) => thread.threadId)).toEqual([
      "real-needs",
    ]);
    expect(state.needsOutcomeCount).toBe(1);
    expect(state.unreadCount).toBe(1);
    expect(state.hiddenDncCount).toBe(2);
  });

  it("shows DNC and test threads in the list and counts when the noise toggle is off", () => {
    const threads = [
      makeThread({ threadId: "real-needs", needsOutcome: true }),
      makeThread({
        threadId: "test-needs",
        needsOutcome: true,
        isTestTraffic: true,
      }),
    ];

    const state = resolveVisibleThreadState(threads, "needs_outcome", {
      currentUserId: "user-1",
      canonicalThreadId: null,
      hideDnc: false,
    });

    expect(state.threads.map((thread) => thread.threadId)).toEqual([
      "real-needs",
      "test-needs",
    ]);
    expect(state.needsOutcomeCount).toBe(2);
    expect(state.hiddenDncCount).toBe(0);
  });

  it("keeps the shell thread count stable on non-thread Unknown/Dismissed buckets", () => {
    const threads = [
      makeThread({ threadId: "real-thread" }),
      makeThread({ threadId: "hidden-thread", isTestTraffic: true }),
    ];

    const state = resolveVisibleThreadState(threads, "unknown", {
      currentUserId: "user-1",
      canonicalThreadId: null,
      hideDnc: true,
    });

    expect(state.threads.map((thread) => thread.threadId)).toEqual([
      "real-thread",
    ]);
    expect(state.hiddenDncCount).toBe(1);
  });
});
