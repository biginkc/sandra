import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

type MembershipResetReader = {
  from(table: "memberships"): {
    select(columns: "user_id"): {
      in(
        column: "user_id",
        values: string[],
      ): Promise<{
        data: Array<{ user_id: string }> | null;
        error: { message: string } | null;
      }>;
    };
  };
};

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
  const { error } = await client.rpc("reset_tenant_tables");
  if (error) {
    throw new Error(`reset_tenant_tables() failed: ${error.message}`);
  }

  const { data: users, error: usersError } =
    await client.auth.admin.listUsers();
  if (usersError) {
    throw new Error(`listUsers() failed after reset: ${usersError.message}`);
  }

  const knownUserIds = users.users.map((user) => user.id);
  if (knownUserIds.length === 0) return;

  const { data: memberships, error: membershipsError } = await (
    client as unknown as MembershipResetReader
  )
    .from("memberships")
    .select("user_id")
    .in("user_id", knownUserIds);
  if (membershipsError) {
    if (membershipsError.message.includes("public.memberships")) {
      return;
    }
    throw new Error(
      `memberships check failed after reset: ${membershipsError.message}`,
    );
  }

  const preservedUserIds = new Set(
    (memberships ?? []).map((row: { user_id: string }) => row.user_id),
  );
  const missingUserIds = knownUserIds.filter(
    (userId) => !preservedUserIds.has(userId),
  );
  if (missingUserIds.length > 0) {
    throw new Error(
      `reset_tenant_tables() removed memberships for users: ${missingUserIds.join(", ")}`,
    );
  }
}
