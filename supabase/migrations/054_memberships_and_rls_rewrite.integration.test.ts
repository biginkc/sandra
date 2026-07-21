import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthorizationError } from "@/lib/errors/classes";
import { requireOrgMembershipByResource } from "@/lib/auth/require-org-membership";
import { grantUserAccess } from "@/app/(dashboard)/admin/users/actions";
import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";

const mocks = vi.hoisted(() => ({
  serverClient: undefined as unknown,
  adminClient: undefined as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => mocks.serverClient,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mocks.adminClient,
}));

const serviceClient = createTestClient();
const createdUserIds: string[] = [];
const createdObjectPaths: string[] = [];

type MembershipTestClient = {
  from(table: "memberships"): {
    select(
      columns: string,
      options?: { count?: "exact"; head?: boolean },
    ):
      | Promise<{
          data: Array<{ user_id: string; org_id: string; role: string }> | null;
          count: number | null;
          error: { message: string } | null;
        }>
      | {
          eq(
            column: string,
            value: string,
          ): Promise<{
            data:
              | Array<{ user_id: string; org_id: string; role: string }>
              | null;
            error: { message: string } | null;
          }>;
        };
  };
};

function uniqueEmail(label: string): string {
  return `stage1-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@bmhgroupkc.com`;
}

async function createUserForOrg(orgId: string, role: "owner" | "member") {
  const user = await createOrgUser(serviceClient, {
    orgId,
    email: uniqueEmail(`${orgId.slice(-3)}-${role}`),
    role,
  });
  createdUserIds.push(user.userId);
  return { ...user, client: clientForUser(user.jwt) };
}

async function insertProperty(orgId: string, address: string): Promise<string> {
  const { data, error } = await serviceClient
    .from("properties")
    .insert({ org_id: orgId, address, state: "MO", status: "new_lead" })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`insertProperty failed: ${error?.message ?? "no data"}`);
  }
  return data.id;
}

beforeAll(async () => {
  vi.stubEnv("ADMIN_EMAILS", "jarrad@bmhgroupkc.com");
  await resetTenantTables(serviceClient);
  await seedTwoOrgs(serviceClient);
});

afterAll(async () => {
  if (createdObjectPaths.length > 0) {
    await serviceClient.storage.from("csv-imports").remove(createdObjectPaths);
  }
  for (const userId of createdUserIds) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
  await resetTenantTables(serviceClient);
  vi.unstubAllEnvs();
});

describe("Migration 054 — memberships foundation + RLS rewrite", () => {
  it("keeps memberships attached only to real auth users", async () => {
    // perPage must exceed the project's total user count — the default
    // page size is 50, and accumulated test users past that made every
    // membership on page 2+ look orphaned (false failures 2026-06-12).
    const { data: users, error: usersError } =
      await serviceClient.auth.admin.listUsers({ page: 1, perPage: 1000 });
    expect(usersError).toBeNull();

    const { data: memberships, error: membershipError } = (await (
      serviceClient as unknown as MembershipTestClient
    )
      .from("memberships")
      .select("user_id, org_id, role")) as {
      data: Array<{ user_id: string; org_id: string; role: string }>;
      error: { message: string } | null;
    };
    expect(membershipError).toBeNull();
    const knownUserIds = new Set(users.users.map((user) => user.id));
    expect(memberships.length).toBeGreaterThan(0);
    for (const membership of memberships) {
      expect(knownUserIds.has(membership.user_id)).toBe(true);
    }
  });

  it("scopes direct org tables by caller membership", async () => {
    const bmhUser = await createUserForOrg(BMH_ORG_ID, "member");
    const orgBUser = await createUserForOrg(TEST_ORG_B_ID, "member");
    const bmhPropertyId = await insertProperty(BMH_ORG_ID, "053 BMH visible");
    await insertProperty(TEST_ORG_B_ID, "053 Org B hidden");

    const { data: bmhRows, error: bmhError } = await bmhUser.client
      .from("properties")
      .select("id, org_id")
      .eq("id", bmhPropertyId);
    expect(bmhError).toBeNull();
    expect(bmhRows).toHaveLength(1);
    expect(bmhRows?.[0]?.org_id).toBe(BMH_ORG_ID);

    const { data: crossRows, error: crossError } = await orgBUser.client
      .from("properties")
      .select("id")
      .eq("org_id", BMH_ORG_ID);
    expect(crossError).toBeNull();
    expect(crossRows).toHaveLength(0);
  });

  it("blocks cross-org inserts through direct org policies", async () => {
    const orgBUser = await createUserForOrg(TEST_ORG_B_ID, "member");
    const { error } = await orgBUser.client
      .from("properties")
      .insert({ org_id: BMH_ORG_ID, address: "053 blocked insert", state: "MO" });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/row-level security|violates row-level/i);
  });

  it("hides child-table updates when the parent belongs to another org", async () => {
    const orgBUser = await createUserForOrg(TEST_ORG_B_ID, "member");
    const { data: job } = await serviceClient
      .from("jobs")
      .insert({ org_id: BMH_ORG_ID, type: "csv_import", status: "queued" })
      .select("id")
      .single();
    expect(job?.id).toBeTruthy();

    const { data: item } = await serviceClient
      .from("job_items")
      .insert({ job_id: job!.id, status: "pending" })
      .select("id")
      .single();
    expect(item?.id).toBeTruthy();

    const { data, error } = await orgBUser.client
      .from("job_items")
      .update({ status: "success" })
      .eq("id", item!.id)
      .select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("scopes csv-import storage objects by first path segment org id", async () => {
    const bmhUser = await createUserForOrg(BMH_ORG_ID, "member");
    const bmhPath = `${BMH_ORG_ID}/stage1-${Date.now()}.csv`;
    const orgBPath = `${TEST_ORG_B_ID}/stage1-${Date.now()}.csv`;
    createdObjectPaths.push(bmhPath, orgBPath);

    const { error: ownError } = await bmhUser.client.storage
      .from("csv-imports")
      .upload(bmhPath, new Blob(["address,state\n1 Main,MO\n"], { type: "text/csv" }));
    expect(ownError).toBeNull();

    const { error: crossError } = await bmhUser.client.storage
      .from("csv-imports")
      .upload(orgBPath, new Blob(["address,state\n2 Main,MO\n"], { type: "text/csv" }));
    expect(crossError).not.toBeNull();
  });

  it("limits webhook_consumers writes to org owners", async () => {
    const nonOwner = await createUserForOrg(TEST_ORG_B_ID, "member");
    const { error } = await nonOwner.client.from("webhook_consumers").insert({
      org_id: TEST_ORG_B_ID,
      name: `stage1-${Date.now()}`,
      secret_hash: crypto.randomUUID(),
      default_source: "web_form",
    } as never);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/row-level security|violates row-level/i);
  });

  it("lets authenticated users see only their own memberships", async () => {
    const owner = await createUserForOrg(TEST_ORG_B_ID, "owner");
    const member = await createUserForOrg(TEST_ORG_B_ID, "member");

    const { data: ownerRows, error: ownerError } = await owner.client
      .from("memberships" as never)
      .select("user_id, org_id, role")
      .eq("org_id", TEST_ORG_B_ID);
    expect(ownerError).toBeNull();
    expect(ownerRows).toEqual([
      expect.objectContaining({ user_id: owner.userId }),
    ]);

    const { data: memberRows, error: memberError } = await member.client
      .from("memberships" as never)
      .select("user_id, org_id, role")
      .eq("org_id", TEST_ORG_B_ID);
    expect(memberError).toBeNull();
    expect(memberRows).toEqual([
      expect.objectContaining({ user_id: member.userId }),
    ]);
  });

  it("creates memberships from passwordless grants and rolls back a newly created user on membership failure", async () => {
    const invitedUserId = crypto.randomUUID();
    const upsert = vi.fn().mockResolvedValue({ error: null });
    mocks.serverClient = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: crypto.randomUUID(), email: "jarrad@bmhgroupkc.com" } },
        }),
      },
    };
    mocks.adminClient = {
      auth: {
        admin: {
          listUsers: vi.fn().mockResolvedValue({
            data: { users: [] },
            error: null,
          }),
          createUser: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: invitedUserId,
                email_confirmed_at: "2026-07-21T00:00:00Z",
              },
            },
            error: null,
          }),
          deleteUser: vi.fn().mockResolvedValue({ error: null }),
        },
      },
      from: vi.fn(() => ({ upsert })),
    };

    const result = await grantUserAccess(
      "newperson@bmhgroupkc.com",
      TEST_ORG_B_ID,
      "owner",
    );
    expect(result.ok).toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      {
        user_id: invitedUserId,
        org_id: TEST_ORG_B_ID,
        role: "owner",
      },
      { onConflict: "user_id,org_id" },
    );

    const rollbackUserId = crypto.randomUUID();
    const deleteUser = vi.fn().mockResolvedValue({ error: null });
    mocks.adminClient = {
      auth: {
        admin: {
          listUsers: vi.fn().mockResolvedValue({
            data: { users: [] },
            error: null,
          }),
          createUser: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: rollbackUserId,
                email_confirmed_at: "2026-07-21T00:00:00Z",
              },
            },
            error: null,
          }),
          deleteUser,
        },
      },
      from: vi.fn(() => ({
        upsert: vi.fn().mockResolvedValue({
          error: { message: "membership insert failed" },
        }),
      })),
    };

    const failure = await grantUserAccess("preserve@bmhgroupkc.com");
    expect(failure.ok).toBe(false);
    expect(failure).toMatchObject({
      error: { code: "GRANT_MEMBERSHIP_FAILED" },
    });
    expect(deleteUser).toHaveBeenCalledWith(rollbackUserId);
  });

  it("throws AuthorizationError when resource lookup is hidden by RLS", async () => {
    const orgBUser = await createUserForOrg(TEST_ORG_B_ID, "member");
    const bmhPropertyId = await insertProperty(BMH_ORG_ID, "053 hidden resource");
    mocks.serverClient = orgBUser.client;

    await expect(
      requireOrgMembershipByResource("properties", bmhPropertyId),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("preserves memberships when resetTenantTables runs", async () => {
    const user = await createUserForOrg(TEST_ORG_B_ID, "member");
    await resetTenantTables(serviceClient);

    const { data, error } = await (
      (serviceClient as unknown as MembershipTestClient)
        .from("memberships")
        .select("user_id, org_id, role") as {
        eq(
          column: string,
          value: string,
        ): Promise<{
          data: Array<{ user_id: string; org_id: string; role: string }> | null;
          error: { message: string } | null;
        }>;
      }
    )
      .eq("user_id", user.userId);
    expect(error).toBeNull();
    expect(data).toEqual([
      expect.objectContaining({
        user_id: user.userId,
        org_id: TEST_ORG_B_ID,
        role: "member",
      }),
    ]);
  });

  it("keeps counties visible as authenticated reference data", async () => {
    const user = await createUserForOrg(TEST_ORG_B_ID, "member");
    const { data, error } = await user.client
      .from("counties")
      .select("id, name, state")
      .limit(5);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("locks skip_trace_cache to read-only for tenants and write-only for service role", async () => {
    const member = await createUserForOrg(TEST_ORG_B_ID, "member");

    const seedAddress = `addr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const seed = await serviceClient.from("skip_trace_cache").insert({
      provider: "stage1-fix-test",
      address_normalized: seedAddress,
      result: { phones: [] },
      match_count: 0,
      cost_credits: 0,
    });
    expect(seed.error).toBeNull();

    const memberRead = await member.client
      .from("skip_trace_cache")
      .select("provider, address_normalized")
      .eq("address_normalized", seedAddress)
      .limit(1);
    expect(memberRead.error).toBeNull();
    expect((memberRead.data ?? []).length).toBeGreaterThanOrEqual(1);

    const memberWrite = await member.client.from("skip_trace_cache").insert({
      provider: "stage1-poison",
      address_normalized: `addr-poison-${Date.now()}`,
      result: { phones: [] },
      match_count: 0,
      cost_credits: 0,
    });
    expect(memberWrite.error).not.toBeNull();
    expect(memberWrite.error?.message).toMatch(
      /row-level security|violates row-level/i,
    );
  });
});
