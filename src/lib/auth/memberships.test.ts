import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

import { getCallerMemberships } from "./memberships";

const activeMembership = {
  user_id: "user-1",
  org_id: "org-1",
  role: "owner" as const,
  access_status: "active",
  access_expires_at: null,
  deletion_prepared_at: null,
};

type MembershipResponse = {
  data: typeof activeMembership[] | null;
  error: { code?: string; message?: string } | null;
};

function mockMembershipClient(responses: MembershipResponse | MembershipResponse[]) {
  const select = vi.fn();
  for (const response of Array.isArray(responses) ? responses : [responses]) {
    select.mockResolvedValueOnce(response);
  }
  createClient.mockResolvedValue({
    from: vi.fn(() => ({ select })),
  });
  return { select };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("E2E_AUTH_BYPASS", "1");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("getCallerMemberships", () => {
  it("filters inactive memberships after the Hugo access query succeeds", async () => {
    const { select } = mockMembershipClient({
      data: [
        activeMembership,
        {
          ...activeMembership,
          user_id: "user-2",
          access_status: "suspended",
        },
      ],
      error: null,
    });

    await expect(getCallerMemberships()).resolves.toEqual([activeMembership]);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(
      "user_id, org_id, role, access_status, access_expires_at, deletion_prepared_at",
    );
  });

  it("uses the legacy membership shape only for local E2E when Hugo columns are absent", async () => {
    const { select } = mockMembershipClient(
      [
        {
          data: null,
          error: {
            code: "PGRST204",
            message:
              "Could not find the 'access_status' column of 'memberships' in the schema cache",
          },
        },
        { data: [activeMembership], error: null },
      ],
    );

    await expect(getCallerMemberships()).resolves.toEqual([activeMembership]);
    expect(select).toHaveBeenNthCalledWith(2, "user_id, org_id, role");
  });

  it("fails closed outside local E2E when Hugo columns are absent", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS", "");
    const { select } = mockMembershipClient({
      data: null,
      error: {
        code: "PGRST204",
        message:
          "Could not find the 'access_status' column of 'memberships' in the schema cache",
      },
    });

    await expect(getCallerMemberships()).resolves.toEqual([]);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
