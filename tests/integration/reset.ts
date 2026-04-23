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
  const { error } = await client.rpc("reset_tenant_tables");
  if (error) {
    throw new Error(`reset_tenant_tables() failed: ${error.message}`);
  }
}
