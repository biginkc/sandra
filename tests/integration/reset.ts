import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

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
  // reset_tenant_tables isn't in the generated Database types because it's
  // only ever called from this helper. @ts-expect-error lets us call it by
  // name without a wider type-system workaround (the cast breaks `this`).
  // @ts-expect-error rpc name not in generated types
  const { error } = await client.rpc("reset_tenant_tables");
  if (error) {
    throw new Error(`reset_tenant_tables() failed: ${error.message}`);
  }
}
