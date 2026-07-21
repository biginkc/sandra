import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, createAdminClient } = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { grantUserAccess } from "./actions";

function mockAdminSession(email = "jarrad@bmhgroupkc.com") {
  createClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "admin-user", email } },
      }),
    },
  });
}

function mockAdminClient({
  users = [] as Array<{
    id: string;
    email: string;
    email_confirmed_at?: string | null;
  }>,
  createUser = vi.fn().mockResolvedValue({
    data: {
      user: {
        id: "created-user",
        email: "newperson@bmhgroupkc.com",
        email_confirmed_at: "2026-07-21T00:00:00Z",
      },
    },
    error: null,
  }),
  updateUserById = vi.fn(),
  upsert = vi.fn().mockResolvedValue({ error: null }),
} = {}) {
  const listUsers = vi.fn().mockResolvedValue({
    data: { users },
    error: null,
  });
  const from = vi.fn(() => ({ upsert }));
  createAdminClient.mockReturnValue({
    auth: { admin: { listUsers, createUser, updateUserById } },
    from,
  });
  return { listUsers, createUser, updateUserById, upsert, from };
}

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAILS", "jarrad@bmhgroupkc.com");
  mockAdminSession();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("grantUserAccess", () => {
  it("creates a confirmed passwordless user and grants membership without email", async () => {
    const { createUser, upsert } = mockAdminClient();

    const result = await grantUserAccess("newperson@bmhgroupkc.com");

    expect(result).toEqual({
      ok: true,
      data: {
        grantedEmail: "newperson@bmhgroupkc.com",
        userId: "created-user",
        created: true,
      },
    });
    expect(createUser).toHaveBeenCalledWith({
      email: "newperson@bmhgroupkc.com",
      email_confirm: true,
    });
    expect(createUser.mock.calls[0][0]).not.toHaveProperty("password");
    expect(upsert).toHaveBeenCalledWith(
      {
        user_id: "created-user",
        org_id: "00000000-0000-0000-0000-000000000bbb",
        role: "member",
      },
      { onConflict: "user_id,org_id" },
    );
  });

  it("is idempotent and preserves the existing exact-email UID", async () => {
    const { createUser, upsert } = mockAdminClient({
      users: [
        {
          id: "canonical-user",
          email: "owner@bmhgroupkc.com",
          email_confirmed_at: "2026-07-20T00:00:00Z",
        },
      ],
    });

    const result = await grantUserAccess(
      "OWNER@bmhgroupkc.com",
      "00000000-0000-0000-0000-000000000ccc",
      "owner",
    );

    expect(result).toEqual({
      ok: true,
      data: {
        grantedEmail: "owner@bmhgroupkc.com",
        userId: "canonical-user",
        created: false,
      },
    });
    expect(createUser).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      {
        user_id: "canonical-user",
        org_id: "00000000-0000-0000-0000-000000000ccc",
        role: "owner",
      },
      { onConflict: "user_id,org_id" },
    );
  });

  it("confirms an existing pending user without changing its UID", async () => {
    const updateUserById = vi.fn().mockResolvedValue({
      data: {
        user: {
          id: "pending-user",
          email: "pending@bmhgroupkc.com",
          email_confirmed_at: "2026-07-21T00:00:00Z",
        },
      },
      error: null,
    });
    const { createUser } = mockAdminClient({
      users: [
        {
          id: "pending-user",
          email: "pending@bmhgroupkc.com",
          email_confirmed_at: null,
        },
      ],
      updateUserById,
    });

    const result = await grantUserAccess("pending@bmhgroupkc.com");

    expect(result.ok).toBe(true);
    expect(updateUserById).toHaveBeenCalledWith("pending-user", {
      email_confirm: true,
    });
    expect(createUser).not.toHaveBeenCalled();
  });

  it("confirms the exact-email user found after a concurrent create race", async () => {
    const racedUser = {
      id: "raced-user",
      email: "raced@bmhgroupkc.com",
      email_confirmed_at: null,
    };
    const createUser = vi.fn().mockResolvedValue({
      data: { user: null },
      error: { message: "A user with this email already exists" },
    });
    const updateUserById = vi.fn().mockResolvedValue({
      data: {
        user: { ...racedUser, email_confirmed_at: "2026-07-21T00:00:00Z" },
      },
      error: null,
    });
    const { listUsers } = mockAdminClient({ createUser, updateUserById });
    listUsers
      .mockResolvedValueOnce({ data: { users: [] }, error: null })
      .mockResolvedValueOnce({ data: { users: [racedUser] }, error: null });

    const result = await grantUserAccess("raced@bmhgroupkc.com");

    expect(result).toMatchObject({
      ok: true,
      data: { userId: "raced-user", created: false },
    });
    expect(updateUserById).toHaveBeenCalledWith("raced-user", {
      email_confirm: true,
    });
  });

  it("rejects non-BMH emails before accessing Auth admin", async () => {
    const result = await grantUserAccess("outsider@example.com");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_DOMAIN" },
    });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("does not delete a newly created user when membership upsert fails", async () => {
    const { createUser } = mockAdminClient({
      upsert: vi.fn().mockResolvedValue({
        error: { message: "membership unavailable" },
      }),
    });
    const result = await grantUserAccess("newperson@bmhgroupkc.com");
    expect(createUser).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      error: { code: "GRANT_MEMBERSHIP_FAILED" },
    });
  });
});
