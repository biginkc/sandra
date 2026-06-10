import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

type MembershipSnapshotReader = {
  from(table: "memberships"): {
    select(columns: "user_id, org_id, role"): Promise<{
      data: Array<{ user_id: string; org_id: string; role: string }> | null;
      error: { message: string } | null;
    }>;
  };
};

type MembershipByUsersReader = {
  from(table: "memberships"): {
    select(columns: "user_id, org_id, role"): {
      in(
        column: "user_id",
        values: string[],
      ): Promise<{
        data: Array<{ user_id: string; org_id: string; role: string }> | null;
        error: { message: string } | null;
      }>;
    };
  };
};

const SYSTEM_MANAGED_LISTS = [
  "Auctions",
  "Bank Owned",
  "Bankruptcy",
  "Cash Buyers",
  "Divorce",
  "Failed Listings",
  "Flippers",
  "Free & Clear",
  "High Equity",
  "Liens",
  "On Market",
  "Pre-Foreclosures",
  "Pre-Probate",
  "Senior Owners",
  "Tax Delinquency",
  "Tired Landlords",
  "Upside Down",
  "Vacant",
  "Vacant Land",
  "Zombie Properties",
] as const;

async function ensureSystemManagedLists(
  client: SupabaseClient<Database>,
): Promise<void> {
  const { error } = await client.from("lists").upsert(
    SYSTEM_MANAGED_LISTS.map((name) => ({
      name,
      color: "#10b981",
      system_managed: true,
    })),
    { onConflict: "org_id,name" },
  );
  if (error) {
    throw new Error(`system-managed list reseed failed: ${error.message}`);
  }
}

async function pruneOrphanMemberships(
  client: SupabaseClient<Database>,
  memberships: Array<{ user_id: string; org_id: string; role: string }>,
): Promise<Set<string>> {
  const validUserIds = new Set<string>();
  let page = 1;

  while (true) {
    const { data, error } = await client.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) {
      throw new Error(`listUsers failed after reset: ${error.message}`);
    }

    for (const user of data.users) {
      validUserIds.add(user.id);
    }

    if (!data.nextPage || data.users.length === 0) {
      break;
    }
    page = data.nextPage;
  }
  const orphanUserIds = Array.from(
    new Set(
      memberships
        .map((row) => row.user_id)
        .filter((userId) => !validUserIds.has(userId)),
    ),
  );
  if (orphanUserIds.length > 0) {
    const { error: deleteError } = await client
      .from("memberships")
      .delete()
      .in("user_id", orphanUserIds);
    if (deleteError) {
      throw new Error(`orphan membership prune failed: ${deleteError.message}`);
    }
  }

  return validUserIds;
}

/**
 * Truncate every tenant-data table. Called from `beforeEach` so each
 * integration test starts from a clean slate. Delegates to the
 * `reset_tenant_tables()` Postgres function defined in migration 005 —
 * that function is service_role-gated and lives in every environment,
 * so tests don't need a pg driver.
 */
export async function resetTenantTables(
  client: SupabaseClient<Database>,
): Promise<void> {
  const { data: membershipsBefore, error: membershipsBeforeError } = await (
    client as unknown as MembershipSnapshotReader
  )
    .from("memberships")
    .select("user_id, org_id, role");
  if (membershipsBeforeError) {
    if (!membershipsBeforeError.message.includes("public.memberships")) {
      throw new Error(
        `memberships snapshot failed before reset: ${membershipsBeforeError.message}`,
      );
    }
  }

  const { error } = await client.rpc("reset_tenant_tables");
  if (error) {
    throw new Error(`reset_tenant_tables() failed: ${error.message}`);
  }

  await ensureSystemManagedLists(client);

  const validUserIds = await pruneOrphanMemberships(
    client,
    membershipsBefore ?? [],
  );

  const expectedMemberships = (membershipsBefore ?? []).filter((row) =>
    validUserIds.has(row.user_id),
  );
  const knownUserIds = Array.from(
    new Set(expectedMemberships.map((row) => row.user_id)),
  );
  if (knownUserIds.length === 0) return;

  const { data: memberships, error: membershipsError } = await (
    client as unknown as MembershipByUsersReader
  )
    .from("memberships")
    .select("user_id, org_id, role")
    .in("user_id", knownUserIds);
  if (membershipsError) {
    if (membershipsError.message.includes("public.memberships")) {
      return;
    }
    throw new Error(
      `memberships check failed after reset: ${membershipsError.message}`,
    );
  }

  const preservedMembershipKeys = new Set(
    (memberships ?? []).map(
      (row: { user_id: string; org_id: string; role: string }) =>
        `${row.user_id}:${row.org_id}:${row.role}`,
    ),
  );
  const missingMemberships = expectedMemberships.filter(
    (row) =>
      !preservedMembershipKeys.has(`${row.user_id}:${row.org_id}:${row.role}`),
  );
  if (missingMemberships.length > 0) {
    throw new Error(
      `reset_tenant_tables() removed memberships: ${missingMemberships
        .map((row) => `${row.user_id}/${row.org_id}/${row.role}`)
        .join(", ")}`,
    );
  }
}
