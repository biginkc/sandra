import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { updateMembershipRole } from "@/app/(dashboard)/admin/users/actions";
import { AuthorizationError } from "@/lib/errors/classes";
import { requireOrgMembershipByResource } from "@/lib/auth/require-org-membership";
import type { Database } from "@/lib/supabase/types";
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
            data: Array<{
              user_id: string;
              org_id: string;
              role: string;
            }> | null;
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
  vi.stubEnv("ADMIN_EMAILS", "admin@bmhgroupkc.com");
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
    const { error } = await orgBUser.client.from("properties").insert({
      org_id: BMH_ORG_ID,
      address: "053 blocked insert",
      state: "MO",
    });
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
      .upload(
        bmhPath,
        new Blob(["address,state\n1 Main,MO\n"], { type: "text/csv" }),
      );
    expect(ownError).toBeNull();

    const { error: crossError } = await bmhUser.client.storage
      .from("csv-imports")
      .upload(
        orgBPath,
        new Blob(["address,state\n2 Main,MO\n"], { type: "text/csv" }),
      );
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

  it("persists an existing member role change without breaking a fresh sign-in", async () => {
    const email = uniqueEmail("role-change");
    const password = `Sandra-role-${crypto.randomUUID()}`;
    const { data: created, error: createError } =
      await serviceClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
    expect(createError).toBeNull();
    expect(created.user).not.toBeNull();
    const userId = created.user!.id;
    createdUserIds.push(userId);

    const { error: membershipError } = await serviceClient
      .from("memberships")
      .insert({ user_id: userId, org_id: BMH_ORG_ID, role: "member" });
    expect(membershipError).toBeNull();

    mocks.serverClient = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: crypto.randomUUID(),
              email: "admin@bmhgroupkc.com",
            },
          },
        }),
      },
    };
    mocks.adminClient = serviceClient;

    await expect(updateMembershipRole(userId, "owner")).resolves.toEqual({
      ok: true,
      data: { userId, role: "owner" },
    });

    const { data: savedMembership, error: savedMembershipError } =
      await serviceClient
        .from("memberships")
        .select("role,access_status,access_expires_at,deletion_prepared_at")
        .eq("user_id", userId)
        .eq("org_id", BMH_ORG_ID)
        .single();
    expect(savedMembershipError).toBeNull();
    expect(savedMembership).toEqual({
      role: "owner",
      access_status: "active",
      access_expires_at: null,
      deletion_prepared_at: null,
    });

    const signedInClient = createClient<Database>(
      process.env.TEST_SUPABASE_URL!,
      process.env.TEST_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data: signedIn, error: signInError } =
      await signedInClient.auth.signInWithPassword({ email, password });
    expect(signInError).toBeNull();
    expect(signedIn.user?.id).toBe(userId);

    const { data: ownMembership, error: ownMembershipError } =
      await signedInClient
        .from("memberships")
        .select("role")
        .eq("org_id", BMH_ORG_ID)
        .single();
    expect(ownMembershipError).toBeNull();
    expect(ownMembership).toEqual({ role: "owner" });
  });

  it.each([
    {
      label: "suspended and deletion-prepared",
      lifecycle: {
        access_status: "suspended",
        access_expires_at: "2026-08-31T17:00:00.000Z",
        deletion_prepared_at: "2026-07-29T17:00:00.000Z",
      },
    },
    {
      label: "active but expired",
      lifecycle: {
        access_status: "active",
        access_expires_at: "2026-07-01T17:00:00.000Z",
        deletion_prepared_at: null,
      },
    },
  ])(
    "rejects a $label role change and preserves Hugo lifecycle state",
    async ({ lifecycle }) => {
      const managedUser = await createUserForOrg(BMH_ORG_ID, "member");
      const { error: lifecycleError } = await serviceClient
        .from("memberships")
        .update(lifecycle)
        .eq("user_id", managedUser.userId)
        .eq("org_id", BMH_ORG_ID);
      expect(lifecycleError).toBeNull();
      const { data: lifecycleBefore, error: lifecycleBeforeError } =
        await serviceClient
          .from("memberships")
          .select("role,access_status,access_expires_at,deletion_prepared_at")
          .eq("user_id", managedUser.userId)
          .eq("org_id", BMH_ORG_ID)
          .single();
      expect(lifecycleBeforeError).toBeNull();
      expect(lifecycleBefore).toMatchObject({
        role: "member",
        access_status: lifecycle.access_status,
        access_expires_at: expect.any(String),
        deletion_prepared_at: lifecycle.deletion_prepared_at
          ? expect.any(String)
          : null,
      });

      mocks.serverClient = {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: crypto.randomUUID(),
                email: "admin@bmhgroupkc.com",
              },
            },
          }),
        },
      };
      mocks.adminClient = serviceClient;

      await expect(
        updateMembershipRole(managedUser.userId, "owner"),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: "MEMBERSHIP_NOT_FOUND",
          message:
            "This person does not have active Sandra access. Add or reactivate them in Hugo first.",
        },
      });

      const { data: savedMembership, error: savedMembershipError } =
        await serviceClient
          .from("memberships")
          .select("role,access_status,access_expires_at,deletion_prepared_at")
          .eq("user_id", managedUser.userId)
          .eq("org_id", BMH_ORG_ID)
          .single();
      expect(savedMembershipError).toBeNull();
      expect(savedMembership).toEqual(lifecycleBefore);
    },
  );

  it("throws AuthorizationError when resource lookup is hidden by RLS", async () => {
    const orgBUser = await createUserForOrg(TEST_ORG_B_ID, "member");
    const bmhPropertyId = await insertProperty(
      BMH_ORG_ID,
      "053 hidden resource",
    );
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
    ).eq("user_id", user.userId);
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
