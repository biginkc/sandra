import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getCallerMembershipsOrThrow: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth/memberships", () => ({
  getCallerMembershipsOrThrow: mocks.getCallerMembershipsOrThrow,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("./client", () => ({
  SlackPreviewsClient: ({ orgId }: { orgId: string | null }) => (
    <div data-testid="slack-previews-client" data-org-id={orgId ?? ""} />
  ),
}));

import SlackPreviewsSettingsPage from "./page";

const activeMembership = (orgId: string, role: "owner" | "member" = "member") => ({
  user_id: "user-1",
  org_id: orgId,
  role,
  access_status: "active",
  access_expires_at: null,
  deletion_prepared_at: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }) },
  });
  mocks.getCallerMembershipsOrThrow.mockResolvedValue([activeMembership("org-1", "owner")]);
});

describe("SlackPreviewsSettingsPage organization selection", () => {
  it("passes an explicitly requested active organization to the API client", async () => {
    mocks.getCallerMembershipsOrThrow.mockResolvedValue([
      activeMembership("org-1", "owner"),
      activeMembership("org-2"),
    ]);

    render(await SlackPreviewsSettingsPage({
      searchParams: Promise.resolve({ orgId: "org-2" }),
    }));

    expect(screen.getByTestId("slack-previews-client")).toHaveAttribute(
      "data-org-id",
      "org-2",
    );
  });

  it("does not silently choose the first organization when several are active", async () => {
    mocks.getCallerMembershipsOrThrow.mockResolvedValue([
      activeMembership("org-1", "owner"),
      activeMembership("org-2"),
    ]);

    render(await SlackPreviewsSettingsPage({
      searchParams: Promise.resolve({}),
    }));

    expect(screen.getByTestId("slack-previews-client")).toHaveAttribute(
      "data-org-id",
      "",
    );
  });

  it("falls back to the only active organization", async () => {
    render(await SlackPreviewsSettingsPage({
      searchParams: Promise.resolve({}),
    }));

    expect(screen.getByTestId("slack-previews-client")).toHaveAttribute(
      "data-org-id",
      "org-1",
    );
  });
});
