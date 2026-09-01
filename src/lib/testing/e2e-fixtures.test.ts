import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ensureTestUser, TEST_USER_EMAIL } from "../../../e2e/fixtures";

const fixturesSource = readFileSync(path.resolve(__dirname, "../../../e2e/fixtures.ts"), "utf8");

function clientWithMembershipResult(error: { message: string } | null) {
  const upsert = vi.fn().mockResolvedValue({ error });
  return {
    auth: {
      admin: {
        listUsers: vi.fn().mockResolvedValue({
          data: {
            users: [{ id: "user-123", email: TEST_USER_EMAIL, app_metadata: { owner: "github-actions", purpose: "ci-e2e", run_slug: "gha-1-1", principal: "primary" } }],
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
  it("passes dedicated CI identity context to the Supabase target guard", () => {
    expect(fixturesSource).toContain('dedicatedCi: process.env.E2E_DEDICATED_CI === "1"');
    expect(fixturesSource).toContain("expectedProjectRef: process.env.E2E_CI_SUPABASE_PROJECT_REF");
  });

  it("upserts the default owner membership without rotating an active session", async () => {
    const client = clientWithMembershipResult(null);

    await expect(ensureTestUser(client as never)).resolves.toBe("user-123");

    expect(client.auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(client.__upsert).toHaveBeenCalledWith(
      {
        user_id: "user-123",
        org_id: "00000000-0000-0000-0000-000000000bbb",
        role: "owner",
      },
      { onConflict: "user_id,org_id" },
    );
  });

  it("does not expose a password-repair path", async () => {
    const client = clientWithMembershipResult(null);
    await expect(ensureTestUser(client as never)).resolves.toBe("user-123");
    expect(client.auth.admin.updateUserById).not.toHaveBeenCalled();
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
