import { describe, expect, it } from "vitest";

import type { Membership } from "./memberships";
import {
  canAccessMessagesAndLeadsBoard,
  isActiveAcquisitionsMember,
  leadDetailCollection,
  shouldRestrictMessagesAndLeadsBoard,
} from "./surface-access";

const baseMembership: Membership = {
  user_id: "user-1",
  org_id: "org-1",
  role: "member",
  acquisitions_enabled: false,
  access_status: "active",
  access_expires_at: null,
  deletion_prepared_at: null,
};

describe("shared Messages and Leads board access", () => {
  it.each([
    ["owner", { ...baseMembership, role: "owner" as const, acquisitions_enabled: false }, false],
    ["active non-Acquisitions member", baseMembership, false],
    ["active Acquisitions member", { ...baseMembership, acquisitions_enabled: true }, true],
  ])("%s follows the membership boundary", (_label, membership, restricted) => {
    expect(shouldRestrictMessagesAndLeadsBoard([membership])).toBe(restricted);
  });

  it("does not restrict a former or expired Acquisitions membership", () => {
    expect(
      isActiveAcquisitionsMember({
        ...baseMembership,
        acquisitions_enabled: true,
        access_status: "suspended",
      }),
    ).toBe(false);
    expect(
      isActiveAcquisitionsMember({
        ...baseMembership,
        acquisitions_enabled: true,
        access_expires_at: "2020-01-01T00:00:00Z",
      }),
    ).toBe(false);
  });

  it("lets an active owner keep board access even when another membership is Acquisitions", () => {
    expect(
      shouldRestrictMessagesAndLeadsBoard([
        { ...baseMembership, acquisitions_enabled: true },
        { ...baseMembership, user_id: "owner-1", role: "owner", acquisitions_enabled: false },
      ]),
    ).toBe(false);
  });

  it("does not let an inactive owner override an active Acquisitions membership", () => {
    expect(
      shouldRestrictMessagesAndLeadsBoard([
        { ...baseMembership, acquisitions_enabled: true },
        {
          ...baseMembership,
          user_id: "owner-1",
          role: "owner",
          acquisitions_enabled: false,
          access_status: "suspended",
        },
      ]),
    ).toBe(true);
  });

  it("requires an active caller membership before granting a shared surface", () => {
    expect(canAccessMessagesAndLeadsBoard([])).toBe(false);
    expect(canAccessMessagesAndLeadsBoard([baseMembership])).toBe(true);
    expect(
      canAccessMessagesAndLeadsBoard([
        { ...baseMembership, acquisitions_enabled: true },
        { ...baseMembership, org_id: "org-2", acquisitions_enabled: false },
      ]),
    ).toBe(false);
  });

  it("keeps an active owner exception across an Acquisitions membership in another org", () => {
    expect(
      canAccessMessagesAndLeadsBoard([
        { ...baseMembership, acquisitions_enabled: true },
        {
          ...baseMembership,
          org_id: "org-2",
          role: "owner",
          acquisitions_enabled: false,
        },
      ]),
    ).toBe(true);
  });
});

describe("lead detail navigation", () => {
  it("sends an Acquisitions member back to My Leads", () => {
    expect(leadDetailCollection(true)).toEqual({ href: "/my-leads", label: "My Leads" });
    expect(leadDetailCollection(true, "prospect")).toEqual({ href: "/my-leads", label: "My Leads" });
  });

  it("keeps the existing collections for other roles", () => {
    expect(leadDetailCollection(false)).toEqual({ href: "/leads", label: "Leads" });
    expect(leadDetailCollection(false, "prospect")).toEqual({ href: "/properties", label: "Prospects" });
  });
});
