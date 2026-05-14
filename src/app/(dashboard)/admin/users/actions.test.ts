import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, createAdminClient, headersMock } = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  headersMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: headersMock,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

import { inviteUser } from "./actions";

function makeHeaders(values: Record<string, string>) {
  return {
    get(name: string) {
      return values[name.toLowerCase()] ?? null;
    },
  };
}

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
  inviteUserByEmail = vi.fn().mockResolvedValue({
    data: { user: { id: "invited-user" } },
    error: null,
  }),
  upsert = vi.fn().mockResolvedValue({ error: null }),
  insert = vi.fn().mockResolvedValue({ error: null }),
  deleteUser = vi.fn().mockResolvedValue({ error: null }),
} = {}) {
  const from = vi.fn(() => ({ insert, upsert }));
  createAdminClient.mockReturnValue({
    auth: {
      admin: {
        inviteUserByEmail,
        deleteUser,
      },
    },
    from,
  });

  return { inviteUserByEmail, upsert, insert, deleteUser, from };
}

beforeEach(() => {
  headersMock.mockResolvedValue(
    makeHeaders({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "preview.sandra.test",
      host: "internal.vercel.test",
    }),
  );
  mockAdminSession();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("inviteUser", () => {
  it("builds invite links from the current request origin and accept-invite handoff", async () => {
    const { inviteUserByEmail } = mockAdminClient();

    const result = await inviteUser("newperson@bmhgroupkc.com");

    expect(result.ok).toBe(true);
    expect(inviteUserByEmail).toHaveBeenCalledWith("newperson@bmhgroupkc.com", {
      redirectTo: "https://preview.sandra.test/auth/accept-invite",
    });
  });

  it("upserts memberships by user/org so resend retries are idempotent", async () => {
    const { upsert, insert } = mockAdminClient();

    const result = await inviteUser(
      "owner@bmhgroupkc.com",
      "00000000-0000-0000-0000-000000000ccc",
      "owner",
    );

    expect(result.ok).toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      {
        user_id: "invited-user",
        org_id: "00000000-0000-0000-0000-000000000ccc",
        role: "owner",
      },
      { onConflict: "user_id,org_id" },
    );
    expect(insert).not.toHaveBeenCalled();
  });
});
