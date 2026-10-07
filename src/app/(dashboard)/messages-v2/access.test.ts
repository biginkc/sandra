import { describe, expect, it } from "vitest";

import type { Membership } from "@/lib/auth/memberships";

import { canAccessMessagesV2, messagesV2OrgId } from "./access";

const m = (over: Partial<Membership>): Membership => ({
  user_id: "u",
  org_id: "o",
  role: "member",
  acquisitions_enabled: false,
  ...over,
});

describe("canAccessMessagesV2", () => {
  it("allows owners", () => {
    expect(canAccessMessagesV2([m({ role: "owner" })])).toBe(true);
  });
  it("allows acquisitions members (denied by the legacy Messages gate)", () => {
    expect(canAccessMessagesV2([m({ acquisitions_enabled: true })])).toBe(true);
  });
  it("denies plain members", () => {
    expect(canAccessMessagesV2([m({})])).toBe(false);
  });
  it("denies an empty membership set (fail closed)", () => {
    expect(canAccessMessagesV2([])).toBe(false);
  });
  it("denies suspended owners and revoked acquisitions members", () => {
    expect(canAccessMessagesV2([m({ role: "owner", access_status: "suspended" })])).toBe(false);
    expect(canAccessMessagesV2([m({ acquisitions_enabled: true, access_status: "revoked" })])).toBe(false);
  });
});

describe("messagesV2OrgId", () => {
  it("returns the org of the first qualifying membership", () => {
    expect(
      messagesV2OrgId([m({ org_id: "plain" }), m({ org_id: "acq", acquisitions_enabled: true })]),
    ).toBe("acq");
  });
  it("returns null when nothing qualifies", () => {
    expect(messagesV2OrgId([m({})])).toBeNull();
    expect(messagesV2OrgId([])).toBeNull();
  });
});
