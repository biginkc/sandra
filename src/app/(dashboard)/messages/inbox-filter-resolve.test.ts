import { describe, expect, it } from "vitest";

import {
  buildThreadOpts,
  isThreadFilter,
  parseInboxFilter,
} from "./inbox-filter-resolve";

describe("parseInboxFilter", () => {
  it("maps each known ?filter= value to itself", () => {
    for (const f of [
      "unknown",
      "dismissed",
      "mine",
      "unassigned",
      "unread",
      "escalated",
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

  it("never sets escalatedOnly for non-escalated filters", () => {
    for (const f of [
      "all",
      "mine",
      "unassigned",
      "unread",
      "unknown",
      "dismissed",
    ] as const) {
      expect(buildThreadOpts(f, ctx).escalatedOnly).toBeUndefined();
    }
  });
});
