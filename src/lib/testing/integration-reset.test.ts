import { describe, expect, it, vi } from "vitest";

import { resetTenantTables } from "../../../tests/integration/reset";

type Membership = { user_id: string; org_id: string; role: string };

function fixture(options: { failBatch?: number; missingUser?: string } = {}) {
  const rows: Membership[] = Array.from({ length: 250 }, (_, index) => ({
    user_id: `user-${index}`,
    org_id: "org-a",
    role: "member",
  }));
  // Preserve all memberships for a user, including a second organization.
  rows.push({ user_id: "user-175", org_id: "org-b", role: "owner" });
  const query = vi.fn(async (_column: string, ids: string[]) => {
    if (options.failBatch === query.mock.calls.length) {
      return { data: null, error: { message: "Bad Request" } };
    }
    return {
      data: rows.filter(
        (row) => ids.includes(row.user_id) && row.user_id !== options.missingUser,
      ),
      error: null,
    };
  });
  let snapshotRead = false;
  const client = {
    storage: { emptyBucket: vi.fn().mockResolvedValue({ error: null }) },
    rpc: vi.fn().mockResolvedValue({ error: null }),
    auth: {
      admin: {
        listUsers: vi.fn().mockResolvedValue({
          data: { users: rows.slice(0, 250).map((row) => ({ id: row.user_id })) },
          error: null,
        }),
      },
    },
    from: (table: string) => {
      if (table === "lists") {
        return { upsert: vi.fn().mockResolvedValue({ error: null }) };
      }
      if (table !== "memberships") throw new Error(`Unexpected table: ${table}`);
      return {
        select: () => {
          if (!snapshotRead) {
            snapshotRead = true;
            return Promise.resolve({ data: rows, error: null });
          }
          return { in: query };
        },
      };
    },
  } as unknown as Parameters<typeof resetTenantTables>[0];
  return { client, query };
}

describe("integration reset membership verification", () => {
  it("verifies every membership across bounded requests, including multiple organizations", async () => {
    const { client, query } = fixture();
    await expect(resetTenantTables(client)).resolves.toBeUndefined();
    const batches = query.mock.calls.map((call) => call[1]);
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(
      Array.from({ length: 250 }, (_, index) => `user-${index}`),
    );
  });

  it("still rejects a missing membership in a later batch", async () => {
    const { client } = fixture({ missingUser: "user-175" });
    await expect(resetTenantTables(client)).rejects.toThrow(
      "reset_tenant_tables() removed memberships: user-175/org-a/member, user-175/org-b/owner",
    );
  });

  it("propagates a later request failure instead of accepting partial verification", async () => {
    const { client, query } = fixture({ failBatch: 2 });
    await expect(resetTenantTables(client)).rejects.toThrow(
      "memberships check failed after reset: Bad Request",
    );
    expect(query).toHaveBeenCalledTimes(2);
  });
});
