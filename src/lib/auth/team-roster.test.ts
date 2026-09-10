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
        getUserById: vi.fn(async (id: string) => ({
          data: { user: options.users.find((user) => user.id === id) ?? null },
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


describe("targeted roster identities", () => {
  it("looks up only scoped unique members and never enumerates Auth", async () => {
    const admin = adminStub({
      memberships: [
        { user_id: "active", access_status: "active" },
        { user_id: "expired", access_status: "active", access_expires_at: "2000-01-01" },
      ],
      users: ["active", "expired", "former", "unrelated"].map((id) => ({
        id, email: `${id}@example.test`, user_metadata: {},
      })),
    });
    createAdminClient.mockReturnValue(admin);
    const members = await loadOrgTeamMembers("org-1", {
      historicalAssigneeIds: ["former", "former"],
      includeInactiveMembers: true,
    });
    expect(admin.auth.admin.getUserById.mock.calls.map(([id]) => id).sort())
      .toEqual(["active", "expired", "former"]);
    expect(members.find((member) => member.id === "expired")?.isActive).toBe(false);
    expect(members.find((member) => member.id === "former")?.isActive).toBe(false);
  });

  it("bounds outstanding identity reads to four", async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `member-${i}`);
    const admin = adminStub({
      memberships: ids.map((id) => ({ user_id: id, access_status: "active" })),
      users: [],
    });
    let outstanding = 0;
    let maximum = 0;
    admin.auth.admin.getUserById.mockImplementation(async (id) => {
      outstanding++;
      maximum = Math.max(maximum, outstanding);
      await new Promise((resolve) => setTimeout(resolve, 1));
      outstanding--;
      return { data: { user: { id, email: `${id}@example.test`, user_metadata: {} } }, error: null };
    });
    createAdminClient.mockReturnValue(admin);
    expect(await loadOrgTeamMembers("org-1")).toHaveLength(11);
    expect(maximum).toBe(4);
    expect(outstanding).toBe(0);
  });

  it("preserves fail-closed labels while allowing explicit display-only fallback", async () => {
    const admin = adminStub({
      memberships: [{ user_id: "missing", access_status: "active" }], users: [],
    });
    admin.auth.admin.getUserById.mockRejectedValue(new Error("Auth unavailable"));
    createAdminClient.mockReturnValue(admin);
    await expect(loadOrgTeamMembers("org-1")).rejects.toThrow("Auth unavailable");
    await expect(loadOrgTeamMembers("org-1", { allowMissingIdentityLabels: true }))
      .resolves.toEqual([{ id: "missing", email: null, displayName: null, isActive: true }]);
  });

  it("never substitutes a mismatched upstream identity", async () => {
    const admin = adminStub({
      memberships: [{ user_id: "needed", access_status: "active" }], users: [],
    });
    admin.auth.admin.getUserById.mockResolvedValue({
      data: { user: { id: "foreign", email: "foreign@example.test", user_metadata: {} } }, error: null,
    });
    createAdminClient.mockReturnValue(admin);
    await expect(loadOrgTeamMembers("org-1")).rejects.toThrow("Auth identity mismatch");
  });
});
