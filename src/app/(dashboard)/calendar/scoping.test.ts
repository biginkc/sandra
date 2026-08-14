import { describe, expect, it } from "vitest";

import { resolveAssigneeId } from "./scoping";

const ROSTER = new Set(["user-1", "rep-2"]);
const EMPTY_ROSTER = new Set<string>();

describe("resolveAssigneeId", () => {
  it("defaults a member (no ?assignee= param) to their own items", () => {
    expect(resolveAssigneeId("member", undefined, "user-1", ROSTER)).toBe("user-1");
  });

  it("defaults an owner (no ?assignee= param) to org-wide (undefined)", () => {
    expect(resolveAssigneeId("owner", undefined, "user-1", ROSTER)).toBeUndefined();
  });

  it("lets a member view an explicit teammate via ?assignee=<id> (Codex round 1 — default, not a lockout)", () => {
    expect(resolveAssigneeId("member", "rep-2", "user-1", ROSTER)).toBe("rep-2");
  });

  it("lets a member go org-wide via ?assignee=all", () => {
    expect(resolveAssigneeId("member", "all", "user-1", ROSTER)).toBeUndefined();
  });

  it("resolves ?assignee=me to the caller's own id for either role", () => {
    expect(resolveAssigneeId("member", "me", "user-1", ROSTER)).toBe("user-1");
    expect(resolveAssigneeId("owner", "me", "user-1", ROSTER)).toBe("user-1");
  });

  it("lets an owner filter to an explicit teammate via ?assignee=<id>", () => {
    expect(resolveAssigneeId("owner", "rep-2", "user-1", ROSTER)).toBe("rep-2");
  });

  it("resolves ?assignee=all to org-wide for an owner too", () => {
    expect(resolveAssigneeId("owner", "all", "user-1", ROSTER)).toBeUndefined();
  });

  it("always accepts the caller's own id even if the roster snapshot omits it", () => {
    expect(resolveAssigneeId("member", "user-1", "user-1", EMPTY_ROSTER)).toBe("user-1");
    expect(resolveAssigneeId("owner", "user-1", "user-1", EMPTY_ROSTER)).toBe("user-1");
  });

  describe("Codex round 9 — an id outside the active roster normalizes to the role default", () => {
    it("normalizes an id that never existed on the roster (member → own items)", () => {
      expect(resolveAssigneeId("member", "not-a-real-id", "user-1", ROSTER)).toBe("user-1");
    });

    it("normalizes an id that never existed on the roster (owner → org-wide)", () => {
      expect(resolveAssigneeId("owner", "not-a-real-id", "user-1", ROSTER)).toBeUndefined();
    });

    it("normalizes a deep-linked id for a removed/suspended teammate (member → own items)", () => {
      // "rep-suspended" was once a valid teammate id but is no longer on
      // the active roster snapshot — same treatment as an id that never
      // existed, not a special case.
      expect(resolveAssigneeId("member", "rep-suspended", "user-1", ROSTER)).toBe("user-1");
    });

    it("normalizes a deep-linked id for a removed/suspended teammate (owner → org-wide)", () => {
      expect(resolveAssigneeId("owner", "rep-suspended", "user-1", ROSTER)).toBeUndefined();
    });
  });
});
