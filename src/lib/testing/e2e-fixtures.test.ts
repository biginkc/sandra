import { describe, expect, it, vi } from "vitest";

import {
  ensureTestUser,
  TEST_ASSIGNEE_EMAIL,
  TEST_USER_EMAIL,
} from "../../../e2e/fixtures";

function runSlugFromEmail(email: string): string {
  const match = /^e2e-ci\+(.+)@bmhgroupkc\.com$/.exec(email);
  if (!match?.[1])
    throw new Error("Test identity is outside the CI namespace.");
  return match[1];
}

function exactUser(
  id: string,
  email: string,
  principal: "primary" | "assignee" = "primary",
) {
  return {
    id,
    email,
    app_metadata: {
      owner: "github-actions",
      purpose: "ci-e2e",
      run_slug: runSlugFromEmail(TEST_USER_EMAIL),
      principal,
    },
  };
}

function clientWithUsers(
  initialUsers: Array<ReturnType<typeof exactUser>>,
  membershipError: { message: string } | null = null,
) {
  const users = [...initialUsers];
  const upsert = vi.fn().mockResolvedValue({ error: membershipError });
  const createUser = vi.fn(
    async (input: {
      email: string;
      app_metadata: ReturnType<typeof exactUser>["app_metadata"];
    }) => {
      const user = {
        id: `created-${users.length + 1}`,
        email: input.email,
        app_metadata: input.app_metadata,
      };
      users.push(user);
      return { data: { user }, error: null };
    },
  );
  const updateUserById = vi.fn();
  return {
    auth: {
      admin: {
        listUsers: vi.fn().mockImplementation(async () => ({
          data: { users },
          error: null,
        })),
        createUser,
        updateUserById,
      },
    },
    from: vi.fn((table: string) => {
      expect(table).toBe("memberships");
      return { upsert };
    }),
    __createUser: createUser,
    __updateUserById: updateUserById,
    __upsert: upsert,
  };
}

describe("ensureTestUser", () => {
  it("reuses only the exact run identity and upserts its owner membership", async () => {
    const client = clientWithUsers([exactUser("user-123", TEST_USER_EMAIL)]);

    await expect(ensureTestUser(client as never)).resolves.toBe("user-123");

    expect(client.__createUser).not.toHaveBeenCalled();
    expect(client.__updateUserById).not.toHaveBeenCalled();
    expect(client.__upsert).toHaveBeenCalledWith(
      {
        user_id: "user-123",
        org_id: "00000000-0000-0000-0000-000000000bbb",
        role: "owner",
      },
      { onConflict: "user_id,org_id" },
    );
  });

  it("fails before every write when an exact email has foreign metadata", async () => {
    const mismatched = exactUser("browser-user", TEST_USER_EMAIL);
    mismatched.app_metadata = {
      ...mismatched.app_metadata,
      owner: "browser-qa",
    };
    const client = clientWithUsers([mismatched]);

    await expect(ensureTestUser(client as never)).rejects.toThrow(
      /does not match the exact CI E2E namespace/,
    );

    expect(client.__createUser).not.toHaveBeenCalled();
    expect(client.__updateUserById).not.toHaveBeenCalled();
    expect(client.__upsert).not.toHaveBeenCalled();
  });

  it("creates a marked identity once and then exactly reuses it", async () => {
    const client = clientWithUsers([]);

    const first = await ensureTestUser(client as never);
    const second = await ensureTestUser(client as never);

    expect(first).toBe(second);
    expect(client.__createUser).toHaveBeenCalledTimes(1);
    expect(client.__createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: TEST_USER_EMAIL,
        email_confirm: true,
        app_metadata: {
          owner: "github-actions",
          purpose: "ci-e2e",
          run_slug: runSlugFromEmail(TEST_USER_EMAIL),
          principal: "primary",
        },
      }),
    );
    expect(client.__updateUserById).not.toHaveBeenCalled();
  });

  it("uses the same run namespace for an exact member assignee", async () => {
    const client = clientWithUsers([
      exactUser("assignee-123", TEST_ASSIGNEE_EMAIL, "assignee"),
    ]);

    await expect(
      ensureTestUser(client as never, {
        principal: "assignee",
        membershipRole: "member",
      }),
    ).resolves.toBe("assignee-123");

    expect(client.__upsert).toHaveBeenCalledWith(
      {
        user_id: "assignee-123",
        org_id: "00000000-0000-0000-0000-000000000bbb",
        role: "member",
      },
      { onConflict: "user_id,org_id" },
    );
  });

  it("fails loudly when the memberships table is missing", async () => {
    const client = clientWithUsers([exactUser("user-123", TEST_USER_EMAIL)], {
      message:
        "Could not find the table 'public.memberships' in the schema cache",
    });

    await expect(ensureTestUser(client as never)).rejects.toThrow(
      /failed to upsert the run-scoped membership/,
    );
  });
});
