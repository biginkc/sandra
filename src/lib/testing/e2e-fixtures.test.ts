import { describe, expect, it, vi } from "vitest";

import { ensureTestUser, TEST_USER_EMAIL } from "../../../e2e/fixtures";

function clientWithMembershipResult(error: { message: string } | null) {
  const upsert = vi.fn().mockResolvedValue({ error });
  return {
    auth: {
      admin: {
        listUsers: vi.fn().mockResolvedValue({
          data: {
            users: [{ id: "user-123", email: TEST_USER_EMAIL }],
          },
          error: null,
        }),
        updateUserById: vi.fn().mockResolvedValue({ error: null }),
      },
    },
    from: vi.fn((table: string) => {
      expect(table).toBe("memberships");
      return { upsert };
    }),
    __upsert: upsert,
  };
}

describe("ensureTestUser", () => {
  it("upserts the default owner membership for the e2e auth user", async () => {
    const client = clientWithMembershipResult(null);

    await expect(ensureTestUser(client as never)).resolves.toBe("user-123");

    expect(client.__upsert).toHaveBeenCalledWith(
      {
        user_id: "user-123",
        org_id: "00000000-0000-0000-0000-000000000bbb",
        role: "owner",
      },
      { onConflict: "user_id,org_id" },
    );
  });

  it("fails loudly when the memberships table is missing", async () => {
    const client = clientWithMembershipResult({
      message:
        "Could not find the table 'public.memberships' in the schema cache",
    });

    await expect(ensureTestUser(client as never)).rejects.toThrow(
      /failed to upsert membership/,
    );
  });
});
