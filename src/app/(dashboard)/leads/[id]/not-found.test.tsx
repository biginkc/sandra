import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getCallerMemberships = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/memberships", () => ({ getCallerMemberships }));

import LeadNotFound from "./not-found";

beforeEach(() => {
  getCallerMemberships.mockReset();
});

describe("lead detail not-found navigation", () => {
  it("returns an active Acquisitions member to My Leads", async () => {
    getCallerMemberships.mockResolvedValue([
      {
        user_id: "user-1",
        org_id: "org-1",
        role: "member",
        acquisitions_enabled: true,
        access_status: "active",
        access_expires_at: null,
        deletion_prepared_at: null,
      },
    ]);

    render(await LeadNotFound());

    expect(screen.getByRole("link", { name: "Back to My Leads" })).toHaveAttribute(
      "href",
      "/my-leads",
    );
  });

  it("keeps the existing Leads destination for an owner", async () => {
    getCallerMemberships.mockResolvedValue([
      {
        user_id: "owner-1",
        org_id: "org-1",
        role: "owner",
        acquisitions_enabled: false,
        access_status: "active",
        access_expires_at: null,
        deletion_prepared_at: null,
      },
    ]);

    render(await LeadNotFound());

    expect(screen.getByRole("link", { name: "Back to Leads" })).toHaveAttribute(
      "href",
      "/leads",
    );
  });
});
