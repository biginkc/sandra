import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { updateMembershipRole } from "./actions";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: mocks.reportError,
}));

function mockSession({
  email = "admin@bmhgroupkc.com",
  userId = "admin-user",
  membershipData,
  membershipError = null,
  membershipThrown,
}: {
  email?: string | null;
  userId?: string;
  membershipData?: { user_id: string } | null;
  membershipError?: { message: string } | null;
  membershipThrown?: Error;
} = {}) {
  const maybeSingle = vi.fn().mockImplementation(async () => {
    if (membershipThrown) throw membershipThrown;
    return {
      data:
        membershipData === undefined ? { user_id: userId } : membershipData,
      error: membershipError,
    };
  });
  const query = {
    eq: vi.fn(),
    is: vi.fn(),
    or: vi.fn(),
    maybeSingle,
  };
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.or.mockReturnValue(query);
  const select = vi.fn(() => query);
  const from = vi.fn(() => ({ select }));

  mocks.createClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: {
          user: email ? { id: userId, email } : null,
        },
      }),
    },
    from,
  });

  return {
    from,
    select,
    eq: query.eq,
    is: query.is,
    or: query.or,
    maybeSingle,
  };
}

function mockRoleUpdate({
  data = { user_id: "member-user", role: "member" },
  error = null,
  thrown,
}: {
  data?: { user_id: string; role: string } | null;
  error?: { message: string } | null;
  thrown?: Error;
} = {}) {
  const maybeSingle = vi.fn().mockImplementation(async () => {
    if (thrown) throw thrown;
    return { data, error };
  });
  const select = vi.fn(() => ({ maybeSingle }));
  const query = {
    eq: vi.fn(),
    is: vi.fn(),
    or: vi.fn(),
    select,
  };
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.or.mockReturnValue(query);
  const update = vi.fn(() => query);
  const from = vi.fn(() => ({ update }));
  const adminClient = { from };
  mocks.createAdminClient.mockReturnValue(adminClient);

  return {
    adminClient,
    from,
    update,
    eq: query.eq,
    is: query.is,
    or: query.or,
    select,
    maybeSingle,
  };
}

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAILS", "admin@bmhgroupkc.com");
  mockSession();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("updateMembershipRole", () => {
  it.each([
    ["owner", "owner"],
    ["member", "member"],
  ] as const)(
    "updates only the existing membership role to %s",
    async (requestedRole, savedRole) => {
      const caller = mockSession();
      const client = mockRoleUpdate({
        data: { user_id: "member-user", role: savedRole },
      });

      const result = await updateMembershipRole("member-user", requestedRole);

      expect(result).toEqual({
        ok: true,
        data: { userId: "member-user", role: savedRole },
      });
      expect(caller.from).toHaveBeenCalledWith("memberships");
      expect(caller.select).toHaveBeenCalledWith("user_id");
      expect(caller.eq).toHaveBeenNthCalledWith(1, "user_id", "admin-user");
      expect(caller.eq).toHaveBeenNthCalledWith(
        2,
        "org_id",
        "00000000-0000-0000-0000-000000000bbb",
      );
      expect(caller.eq).toHaveBeenNthCalledWith(
        3,
        "access_status",
        "active",
      );
      expect(caller.is).toHaveBeenCalledWith("deletion_prepared_at", null);
      expect(caller.or).toHaveBeenCalledWith(
        expect.stringMatching(
          /^access_expires_at\.is\.null,access_expires_at\.gt\.\d{4}-\d{2}-\d{2}T/,
        ),
      );
      expect(caller.maybeSingle).toHaveBeenCalledOnce();
      expect(client.from).toHaveBeenCalledWith("memberships");
      expect(client.update).toHaveBeenCalledWith({ role: requestedRole });
      expect(client.eq).toHaveBeenNthCalledWith(1, "user_id", "member-user");
      expect(client.eq).toHaveBeenNthCalledWith(
        2,
        "org_id",
        "00000000-0000-0000-0000-000000000bbb",
      );
      expect(client.eq).toHaveBeenNthCalledWith(3, "access_status", "active");
      expect(client.is).toHaveBeenCalledWith("deletion_prepared_at", null);
      expect(client.or).toHaveBeenCalledWith(
        expect.stringMatching(
          /^access_expires_at\.is\.null,access_expires_at\.gt\.\d{4}-\d{2}-\d{2}T/,
        ),
      );
      expect(client.select).toHaveBeenCalledWith("user_id,role");
      expect(client.maybeSingle).toHaveBeenCalledOnce();
      expect(client.adminClient).not.toHaveProperty("auth");
    },
  );

  it("does not create a membership when Hugo has not granted access", async () => {
    const client = mockRoleUpdate({ data: null });

    const result = await updateMembershipRole("not-a-member", "member");

    expect(result).toEqual({
      ok: false,
      error: {
        code: "MEMBERSHIP_NOT_FOUND",
        message:
          "This person does not have active Sandra access. Add or reactivate them in Hugo first.",
      },
    });
    expect(client.update).toHaveBeenCalledWith({ role: "member" });
  });

  it("rejects invalid roles before opening an admin client", async () => {
    const result = await updateMembershipRole(
      "member-user",
      "super-admin" as "owner",
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INVALID_ROLE",
        message: "Role must be owner or member.",
      },
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("rejects a blank target before opening an admin client", async () => {
    const result = await updateMembershipRole(" ", "member");

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_USER" },
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("requires the existing Sandra admin allowlist", async () => {
    mockSession({ email: "member@bmhgroupkc.com" });

    const result = await updateMembershipRole("member-user", "owner");

    expect(result).toMatchObject({
      ok: false,
      error: { code: "NOT_ADMIN" },
    });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "has no active Sandra membership",
      membershipData: null,
      membershipError: null,
    },
    {
      label: "has a mismatched membership result",
      membershipData: { user_id: "different-user" },
      membershipError: null,
    },
    {
      label: "cannot verify their membership",
      membershipData: null,
      membershipError: { message: "membership lookup unavailable" },
    },
  ])(
    "denies an allowlisted admin who $label before opening an admin client",
    async ({ membershipData, membershipError }) => {
      mockSession({ membershipData, membershipError });

      const result = await updateMembershipRole("member-user", "owner");

      expect(result).toEqual({
        ok: false,
        error: {
          code: "NOT_ADMIN",
          message: "Only admins with active Sandra access can change roles.",
        },
      });
      expect(mocks.createAdminClient).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the caller membership lookup throws", async () => {
    mockSession({
      membershipThrown: new Error("caller membership transport unavailable"),
    });

    const result = await updateMembershipRole("member-user", "owner");

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ROLE_UPDATE_FAILED" },
    });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("surfaces database failures without mutating Auth", async () => {
    const client = mockRoleUpdate({
      data: null,
      error: { message: "membership update unavailable" },
    });

    const result = await updateMembershipRole("member-user", "owner");

    expect(result).toEqual({
      ok: false,
      error: {
        code: "ROLE_UPDATE_FAILED",
        message: "membership update unavailable",
      },
    });
    expect(client.adminClient).not.toHaveProperty("auth");
  });

  it("fails if the saved role cannot be verified", async () => {
    mockRoleUpdate({
      data: { user_id: "member-user", role: "member" },
    });

    const result = await updateMembershipRole("member-user", "owner");

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ROLE_UPDATE_FAILED" },
    });
  });

  it("reports unexpected failures without exposing account lifecycle methods", async () => {
    const client = mockRoleUpdate({
      thrown: new Error("transport unavailable"),
    });

    const result = await updateMembershipRole("member-user", "owner");

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ROLE_UPDATE_FAILED" },
    });
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "transport unavailable" }),
      {
        tags: { surface: "update_membership_role" },
        extra: { userId: "member-user", role: "owner" },
      },
    );
    expect(client.adminClient).not.toHaveProperty("auth");
  });
});
