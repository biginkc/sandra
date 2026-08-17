import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { resetTenantTables } from "../reset";

/**
 * Tracks organizations created by an integration-test file and removes them
 * after tenant data has been reset. Register cleanup in an `afterEach` hook so
 * a failed assertion cannot strand a temporary tenant in the shared test DB.
 */
export function createTemporaryOrganizationTracker(
  client: SupabaseClient<Database>,
): {
  create(namePrefix: string): Promise<{ id: string }>;
  cleanup(): Promise<void>;
} {
  const organizationIds = new Set<string>();

  return {
    async create(namePrefix) {
      const id = crypto.randomUUID();
      organizationIds.add(id);

      const { error } = await client.from("organizations").insert({
        id,
        name: `${namePrefix} ${id}`,
      });
      if (error) {
        throw new Error(
          `temporary organization insert failed: ${error.message}`,
        );
      }

      return { id };
    },

    async cleanup() {
      if (organizationIds.size === 0) return;

      const ids = [...organizationIds];
      await resetTenantTables(client);

      const { error } = await client
        .from("organizations")
        .delete()
        .in("id", ids);
      if (error) {
        throw new Error(
          `temporary organization cleanup failed: ${error.message}`,
        );
      }

      const { data: remaining, error: verifyError } = await client
        .from("organizations")
        .select("id")
        .in("id", ids);
      if (verifyError) {
        throw new Error(
          `temporary organization cleanup verification failed: ${verifyError.message}`,
        );
      }
      if ((remaining ?? []).length > 0) {
        throw new Error(
          `temporary organization cleanup left ${remaining!.length} row(s)`,
        );
      }

      organizationIds.clear();
    },
  };
}
