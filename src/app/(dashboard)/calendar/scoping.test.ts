import { describe, expect, it } from "vitest";

import { resolveAssigneeId } from "./scoping";

describe("resolveAssigneeId", () => {
  it("defaults a member (no ?assignee= param) to their own items", () => {
    expect(resolveAssigneeId("member", undefined, "user-1")).toBe("user-1");
  });

  it("defaults an owner (no ?assignee= param) to org-wide (undefined)", () => {
    expect(resolveAssigneeId("owner", undefined, "user-1")).toBeUndefined();
  });

  it("lets a member view an explicit teammate via ?assignee=<id> (Codex round 1 — default, not a lockout)", () => {
    expect(resolveAssigneeId("member", "rep-2", "user-1")).toBe("rep-2");
  });

  it("lets a member go org-wide via ?assignee=all", () => {
    expect(resolveAssigneeId("member", "all", "user-1")).toBeUndefined();
  });

  it("resolves ?assignee=me to the caller's own id for either role", () => {
    expect(resolveAssigneeId("member", "me", "user-1")).toBe("user-1");
    expect(resolveAssigneeId("owner", "me", "user-1")).toBe("user-1");
  });

  it("lets an owner filter to an explicit teammate via ?assignee=<id>", () => {
    expect(resolveAssigneeId("owner", "rep-2", "user-1")).toBe("rep-2");
  });

  it("resolves ?assignee=all to org-wide for an owner too", () => {
    expect(resolveAssigneeId("owner", "all", "user-1")).toBeUndefined();
  });
});
