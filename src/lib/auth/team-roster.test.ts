import { afterEach, describe, expect, it, vi } from "vitest";

const { createAdminClient } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

import { loadOrgTeamMembers } from "./team-roster";

type Membership = {
  user_id: string;
  access_status?: string | null;
  access_expires_at?: string | null;
  deletion_prepared_at?: string | null;
};

function adminStub(options: {
  memberships: Membership[];
  primaryError?: { code: string; message: string } | null;
  users: Array<{
    id: string;
    email: string | null;
    user_metadata: Record<string, unknown>;
    app_metadata?: Record<string, unknown>;
  }>;
}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn((columns: string) => {
        const result = columns.includes("access_status")
          ? {
              data: options.primaryError ? null : options.memberships,
              error: options.primaryError ?? null,
            }
          : { data: options.memberships, error: null };
        const builder = {
          eq: vi.fn(() => builder),
          order: vi.fn(() => builder),
          limit: vi.fn(async () => result),
        };
        return builder;
      }),
    })),
    auth: {
      admin: {
        listUsers: vi.fn(async () => ({
          data: { users: options.users, nextPage: null },
          error: null,
        })),
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("loadOrgTeamMembers", () => {
  it("hydrates a server-sourced historical owner after its membership row is removed", async () => {
    createAdminClient.mockReturnValue(
      adminStub({
        memberships: [{ user_id: "active-1", access_status: "active" }],
        users: [
          {
            id: "active-1",
            email: "active@example.test",
            user_metadata: {},
            app_metadata: { display_name: "Active Agent" },
          },
          {
            id: "foreign-1",
            email: "foreign@example.test",
            user_metadata: {},
            app_metadata: { display_name: "Former Agent" },
          },
        ],
      }),
    );

    const members = await loadOrgTeamMembers("org-1", {
      historicalAssigneeIds: ["foreign-1"],
    });

    expect(members).toEqual([
      expect.objectContaining({ id: "active-1", isActive: true }),
      expect.objectContaining({
        id: "foreign-1",
        displayName: "Former Agent",
        isActive: false,
      }),
    ]);
  });

  it("uses the legacy membership shape only in the local E2E lane", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("E2E_AUTH_BYPASS", "1");
    createAdminClient.mockReturnValue(
      adminStub({
        memberships: [{ user_id: "active-1" }],
        primaryError: {
          code: "PGRST204",
          message: "access_status is missing from the schema cache",
        },
        users: [
          {
            id: "active-1",
            email: "active@example.test",
            user_metadata: {},
            app_metadata: { display_name: "Active Agent" },
          },
        ],
      }),
    );

    await expect(loadOrgTeamMembers("org-1")).resolves.toMatchObject([
      { id: "active-1", isActive: true },
    ]);
  });

  it("fails closed on a production lifecycle-schema mismatch", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_AUTH_BYPASS", "1");
    createAdminClient.mockReturnValue(
      adminStub({
        memberships: [],
        primaryError: {
          code: "PGRST204",
          message: "access_status is missing from the schema cache",
        },
        users: [],
      }),
    );

    await expect(loadOrgTeamMembers("org-1")).rejects.toMatchObject({
      code: "PGRST204",
    });
  });
});
