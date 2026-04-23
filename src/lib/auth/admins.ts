import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";
import { isAdminEmail } from "./allowlist";

/**
 * Resolve the set of user IDs whose email matches the ADMIN_EMAILS
 * allowlist. Uses `auth.admin.listUsers()` (service role required) so
 * callers must pass a service-role Supabase client — typically the same
 * one the Dialpad webhook uses, or `createAdminClient()`.
 *
 * Returns `[]` when no auth user matches — that's the "no admins" path
 * the unassigned-inbound dispatch gracefully no-ops into.
 *
 * Capped at 200 users per page. Sandra's team is ~3 today; the cap
 * exists so a runaway team of 250 doesn't silently omit admins. Revisit
 * if the team grows into hundreds.
 */
export async function listAdminUserIds(
  serviceRoleClient: SupabaseClient<Database>,
): Promise<string[]> {
  const { data, error } = await serviceRoleClient.auth.admin.listUsers({
    perPage: 200,
  });
  if (error) {
    throw new Error(`listAdminUserIds failed: ${error.message}`);
  }
  return (data?.users ?? [])
    .filter((u) => isAdminEmail(u.email))
    .map((u) => u.id);
}
