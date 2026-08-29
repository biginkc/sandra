import { describe, expect, it } from "vitest";

import {
  isThreadFilter,
  normalizeInboxFilterForUser,
  parseInboxFilter,
} from "./inbox-filter-resolve";

describe("parseInboxFilter", () => {
  it("maps each known ?filter= value to itself", () => {
    for (const filter of [
      "unknown",
      "dismissed",
      "mine",
      "unassigned",
      "unread",
      "escalated",
      "dispo",
      "needs_outcome",
    ] as const) {
      expect(parseInboxFilter(filter)).toBe(filter);
    }
  });

  it("maps legacy handled links to the Dispo filter", () => {
    expect(parseInboxFilter("handled")).toBe("dispo");
  });

  it("defaults to All for absent, empty, or unrecognized values", () => {
    expect(parseInboxFilter(undefined)).toBe("all");
    expect(parseInboxFilter("")).toBe("all");
    expect(parseInboxFilter("all")).toBe("all");
    expect(parseInboxFilter("bogus")).toBe("all");
    expect(parseInboxFilter("ESCALATED")).toBe("all");
  });
});

describe("isThreadFilter", () => {
  it("treats the seven conversation buckets as thread filters", () => {
    for (const filter of [
      "all",
      "mine",
      "unassigned",
      "unread",
      "escalated",
      "dispo",
      "needs_outcome",
    ] as const) {
      expect(isThreadFilter(filter)).toBe(true);
    }
  });

  it("treats Unknown and Dismissed as sender buckets", () => {
    expect(isThreadFilter("unknown")).toBe(false);
    expect(isThreadFilter("dismissed")).toBe(false);
  });
});

describe("normalizeInboxFilterForUser", () => {
  it("falls back to All for assignment filters without a current user", () => {
    expect(normalizeInboxFilterForUser("mine", null)).toBe("all");
    expect(normalizeInboxFilterForUser("unassigned", null)).toBe("all");
  });

  it("keeps assignment filters for an authenticated user", () => {
    expect(normalizeInboxFilterForUser("mine", "user-1")).toBe("mine");
    expect(normalizeInboxFilterForUser("unassigned", "user-1")).toBe(
      "unassigned",
    );
  });

  it("leaves non-assignment filters unchanged without a current user", () => {
    for (const filter of [
      "all",
      "unread",
      "needs_outcome",
      "escalated",
      "dispo",
      "unknown",
      "dismissed",
    ] as const) {
      expect(normalizeInboxFilterForUser(filter, null)).toBe(filter);
    }
  });
});
