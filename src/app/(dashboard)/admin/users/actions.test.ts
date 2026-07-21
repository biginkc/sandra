import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, createAdminClient } = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { grantUserAccess } from "./actions";

type MockUser = {
  id: string;
  email: string;
  email_confirmed_at: string | null;
  app_metadata: Record<string, unknown>;
};

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
  users = [] as MockUser[],
  membership = null as { role: string } | null,
  upsertError = null as { message: string } | null,
  membershipReads,
  upsertThrows,
  beforeUpsert,
}: {
  users?: MockUser[];
  membership?: { role: string } | null;
  upsertError?: { message: string } | null;
  membershipReads?: Array<{ role: string } | null | Error>;
  upsertThrows?: Error;
  beforeUpsert?: (state: {
    users: MockUser[];
    membership: { role: string } | null;
  }) => Promise<void>;
} = {}) {
  const state = { users: [...users], membership };
  const listUsers = vi.fn().mockImplementation(async () => ({
    data: { users: state.users },
    error: null,
  }));
  const createUser = vi.fn().mockImplementation(async (input) => {
    if (state.users.some((user) => user.email === input.email)) {
      return {
        data: { user: null },
        error: { message: "A user with this email already exists" },
      };
    }
    const user: MockUser = {
      id: "created-user",
      email: input.email,
      email_confirmed_at: input.email_confirm ? "2026-07-21T00:00:00Z" : null,
      app_metadata: input.app_metadata ?? {},
    };
    state.users.push(user);
    return { data: { user }, error: null };
  });
  const updateUserById = vi.fn().mockImplementation(async (id, changes) => {
    const user = state.users.find((candidate) => candidate.id === id);
    if (!user) return { data: { user: null }, error: { message: "not found" } };
    if (changes.email_confirm) {
      user.email_confirmed_at = "2026-07-21T00:00:00Z";
    }
    if (changes.app_metadata) user.app_metadata = changes.app_metadata;
    return { data: { user }, error: null };
  });
  const getUserById = vi.fn().mockImplementation(async (id) => ({
    data: { user: state.users.find((candidate) => candidate.id === id) ?? null },
    error: null,
  }));
  const deleteUser = vi.fn().mockImplementation(async (id) => {
    state.users = state.users.filter((candidate) => candidate.id !== id);
    return { error: null };
  });
  const queuedMembershipReads = [...(membershipReads ?? [])];
  const maybeSingle = vi.fn().mockImplementation(async () => {
    const next = queuedMembershipReads.shift();
    if (next instanceof Error) throw next;
    return {
      data: next === undefined ? state.membership : next,
      error: null,
    };
  });
  const secondEq = vi.fn(() => ({ maybeSingle }));
  const firstEq = vi.fn(() => ({ eq: secondEq }));
  const select = vi.fn(() => ({ eq: firstEq }));
  const upsert = vi.fn().mockImplementation(async (values) => {
    await beforeUpsert?.(state);
    if (upsertThrows) throw upsertThrows;
    if (upsertError) return { error: upsertError };
    state.membership ??= { role: values.role };
    return { error: null };
  });
  const from = vi.fn(() => ({ select, upsert }));
  createAdminClient.mockReturnValue({
    auth: {
      admin: {
        listUsers,
        createUser,
        updateUserById,
        getUserById,
        deleteUser,
      },
    },
    from,
  });
  return {
    state,
    listUsers,
    createUser,
    updateUserById,
    getUserById,
    deleteUser,
    upsert,
  };
}

function existingUser(
  email = "owner@bmhgroupkc.com",
  overrides: Partial<MockUser> = {},
): MockUser {
  return {
    id: "canonical-user",
    email,
    email_confirmed_at: "2026-07-20T00:00:00Z",
    app_metadata: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAILS", "jarrad@bmhgroupkc.com");
  mockAdminSession();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("grantUserAccess", () => {
  it("creates a confirmed passwordless user, grants membership, and marks it ready", async () => {
    const { state, createUser, updateUserById, upsert } = mockAdminClient();

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
      app_metadata: {
        sandra_provisioning_state: "pending",
        sandra_provisioning_attempt: expect.any(String),
        sandra_provisioning_started_at: expect.any(String),
      },
    });
    expect(createUser.mock.calls[0][0]).not.toHaveProperty("password");
    expect(upsert).toHaveBeenCalledWith(
      {
        user_id: "created-user",
        org_id: "00000000-0000-0000-0000-000000000bbb",
        role: "member",
      },
      { onConflict: "user_id,org_id", ignoreDuplicates: true },
    );
    expect(updateUserById).toHaveBeenLastCalledWith(
      "created-user",
      expect.objectContaining({
        app_metadata: expect.objectContaining({
          sandra_provisioning_state: "ready",
          sandra_provisioning_attempt: null,
          sandra_provisioning_started_at: null,
        }),
      }),
    );
    expect(state.membership).toEqual({ role: "member" });
  });

  it("preserves the existing owner UID and role when the UI uses defaults", async () => {
    const { createUser, upsert, state } = mockAdminClient({
      users: [existingUser()],
      membership: { role: "owner" },
    });

    const result = await grantUserAccess("OWNER@bmhgroupkc.com");

    expect(result).toMatchObject({
      ok: true,
      data: { userId: "canonical-user", created: false },
    });
    expect(createUser).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(state.membership).toEqual({ role: "owner" });
  });

  it("ignores a conflicting requested role for an existing membership", async () => {
    const { upsert, state } = mockAdminClient({
      users: [existingUser()],
      membership: { role: "owner" },
    });

    const result = await grantUserAccess(
      "owner@bmhgroupkc.com",
      "00000000-0000-0000-0000-000000000bbb",
      "member",
    );

    expect(result.ok).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
    expect(state.membership).toEqual({ role: "owner" });
  });

  it("confirms an existing unconfirmed canonical user without changing its UID", async () => {
    const { createUser, updateUserById } = mockAdminClient({
      users: [
        existingUser("pending@bmhgroupkc.com", {
          id: "pending-user",
          email_confirmed_at: null,
        }),
      ],
    });

    const result = await grantUserAccess("pending@bmhgroupkc.com");

    expect(result).toMatchObject({
      ok: true,
      data: { userId: "pending-user", created: false },
    });
    expect(updateUserById).toHaveBeenCalledWith("pending-user", {
      email_confirm: true,
    });
    expect(createUser).not.toHaveBeenCalled();
  });

  it("does not adopt or report success for another pending no-membership attempt", async () => {
    const { updateUserById, deleteUser, upsert } = mockAdminClient({
      users: [
        existingUser("raced@bmhgroupkc.com", {
          email_confirmed_at: null,
          app_metadata: {
            sandra_provisioning_state: "pending",
            sandra_provisioning_attempt: "other-attempt",
            sandra_provisioning_started_at: new Date().toISOString(),
          },
        }),
      ],
    });

    const result = await grantUserAccess("raced@bmhgroupkc.com");

    expect(result).toMatchObject({
      ok: false,
      error: { code: "GRANT_IN_PROGRESS" },
    });
    expect(updateUserById).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("deterministically blocks a concurrent grant while the creator is pending", async () => {
    let releaseUpsert!: () => void;
    let enteredUpsert!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredUpsert = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    });
    const { deleteUser } = mockAdminClient({
      beforeUpsert: async () => {
        enteredUpsert();
        await release;
      },
    });

    const first = grantUserAccess("concurrent@bmhgroupkc.com");
    await entered;
    const second = await grantUserAccess("concurrent@bmhgroupkc.com");
    expect(second).toMatchObject({
      ok: false,
      error: { code: "GRANT_IN_PROGRESS" },
    });
    expect(deleteUser).not.toHaveBeenCalled();

    releaseUpsert();
    expect(await first).toMatchObject({ ok: true, data: { created: true } });
  });

  it("rejects non-BMH emails before accessing Auth admin", async () => {
    const result = await grantUserAccess("outsider@example.com");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_DOMAIN" },
    });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("leaves a failed new user pending and recoverable instead of deleting it", async () => {
    const { createUser, deleteUser, state } = mockAdminClient({
      upsertError: { message: "membership unavailable" },
    });
    const result = await grantUserAccess("newperson@bmhgroupkc.com");
    expect(createUser).toHaveBeenCalledOnce();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(state.users[0].app_metadata).toMatchObject({
      sandra_provisioning_state: "pending",
      sandra_provisioning_attempt: expect.any(String),
      sandra_provisioning_started_at: expect.any(String),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "GRANT_MEMBERSHIP_FAILED" },
    });
  });

  it("fails closed without deleting when the initial membership SDK read throws", async () => {
    const { deleteUser, state } = mockAdminClient({
      membershipReads: [new Error("membership read unavailable")],
    });

    const result = await grantUserAccess("read-failure@bmhgroupkc.com");

    expect(result).toMatchObject({ ok: false, error: { code: "GRANT_FAILED" } });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(state.membership).toBeNull();
    expect(state.users[0].app_metadata.sandra_provisioning_state).toBe("pending");
  });

  it("fails closed without deleting when the membership upsert SDK throws", async () => {
    const { deleteUser, state } = mockAdminClient({
      upsertThrows: new Error("upsert transport failed"),
    });

    const result = await grantUserAccess("upsert-throw@bmhgroupkc.com");

    expect(result).toMatchObject({ ok: false, error: { code: "GRANT_FAILED" } });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(state.membership).toBeNull();
    expect(state.users[0].app_metadata.sandra_provisioning_state).toBe("pending");
  });

  it("does not delete when membership verification throws after a successful upsert", async () => {
    const { deleteUser, state } = mockAdminClient({
      membershipReads: [null, new Error("verification unavailable")],
    });

    const result = await grantUserAccess("verify-throw@bmhgroupkc.com");

    expect(result).toMatchObject({ ok: false, error: { code: "GRANT_FAILED" } });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(state.membership).toEqual({ role: "member" });
    expect(state.users[0].app_metadata.sandra_provisioning_state).toBe("pending");
  });

  it("takes over an expired pending lease and completes the original user", async () => {
    const pendingUser = existingUser("stale@bmhgroupkc.com", {
      id: "stale-user",
      app_metadata: {
        sandra_provisioning_state: "pending",
        sandra_provisioning_attempt: "abandoned-attempt",
        sandra_provisioning_started_at: "2026-07-21T00:00:00.000Z",
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:06:00.000Z"));
    const { createUser, updateUserById, state } = mockAdminClient({
      users: [pendingUser],
    });

    const result = await grantUserAccess("stale@bmhgroupkc.com");

    expect(result).toMatchObject({
      ok: true,
      data: { userId: "stale-user", created: false },
    });
    expect(createUser).not.toHaveBeenCalled();
    expect(updateUserById).toHaveBeenCalledWith(
      "stale-user",
      expect.objectContaining({
        app_metadata: expect.objectContaining({
          sandra_provisioning_state: "pending",
          sandra_provisioning_attempt: expect.not.stringContaining("abandoned"),
          sandra_provisioning_started_at: "2026-07-21T00:06:00.000Z",
        }),
      }),
    );
    expect(state.membership).toEqual({ role: "member" });
    expect(state.users[0].app_metadata.sandra_provisioning_state).toBe("ready");
  });

  it("reports a role conflict when concurrent grants race on one existing UID", async () => {
    let entered = 0;
    let release!: () => void;
    const bothAtUpsert = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { state } = mockAdminClient({
      users: [existingUser("race-role@bmhgroupkc.com")],
      beforeUpsert: async () => {
        entered += 1;
        if (entered === 2) release();
        await bothAtUpsert;
      },
    });

    const [ownerResult, memberResult] = await Promise.all([
      grantUserAccess(
        "race-role@bmhgroupkc.com",
        "00000000-0000-0000-0000-000000000bbb",
        "owner",
      ),
      grantUserAccess(
        "race-role@bmhgroupkc.com",
        "00000000-0000-0000-0000-000000000bbb",
        "member",
      ),
    ]);

    expect(state.membership?.role).toBe("owner");
    expect(ownerResult).toMatchObject({ ok: true });
    expect(memberResult).toMatchObject({
      ok: false,
      error: { code: "GRANT_ROLE_CONFLICT" },
    });
  });

  it("never deletes an existing canonical user when membership creation fails", async () => {
    const { deleteUser } = mockAdminClient({
      users: [existingUser()],
      upsertError: { message: "membership unavailable" },
    });
    const result = await grantUserAccess("owner@bmhgroupkc.com");
    expect(deleteUser).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: { code: "GRANT_MEMBERSHIP_FAILED" },
    });
  });
});
