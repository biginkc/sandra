import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

import { requireOrgMembership } from "./require-org-membership";

function mockClient(
  membership: {
    role: string;
    access_status?: string | null;
    access_expires_at?: string | null;
    deletion_prepared_at?: string | null;
  } | null,
  error: { code?: string; message?: string } | null = null,
) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: membership, error });
  const orgEq = vi.fn(() => ({ maybeSingle }));
  const userEq = vi.fn(() => ({ eq: orgEq }));
  const select = vi.fn(() => ({ eq: userEq }));
  createClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-1" } },
      }),
    },
    from: vi.fn(() => ({ select })),
  });
  return { select };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "1");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("requireOrgMembership", () => {
  it("requires active Hugo lifecycle state while Hugo SSO is enabled", async () => {
    mockClient({
      role: "owner",
      access_status: "suspended",
      access_expires_at: null,
      deletion_prepared_at: null,
    });

    await expect(requireOrgMembership("org-1")).rejects.toMatchObject({
      name: "AuthorizationError",
    });
  });

  it("uses the legacy role-only membership shape while Hugo SSO is disabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "");
    const { select } = mockClient({ role: "owner" });

    await expect(requireOrgMembership("org-1")).resolves.toEqual({
      userId: "user-1",
      orgId: "org-1",
      role: "owner",
    });
    expect(select).toHaveBeenCalledWith("role");
  });

  it("fails closed on a legacy membership query error", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "");
    mockClient(null, { code: "PGRST000", message: "unavailable" });

    await expect(requireOrgMembership("org-1")).rejects.toMatchObject({
      name: "AuthorizationError",
    });
  });
});
