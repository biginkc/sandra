import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./types";

/**
 * Build a Supabase client with the service-role key — bypasses RLS and
 * unlocks the `auth.admin.*` methods (createUser, listUsers, deleteUser,
 * etc.) that the app uses for team management.
 *
 * NEVER return this from a server component rendered for an untrusted
 * user. Only call from server actions that have already checked the
 * caller is an admin, or from cron/webhook contexts that don't have
 * a user session at all.
 */
export function createAdminClient(): SupabaseClient<Database> {
  const useTestEnv =
    process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const url = useTestEnv
    ? (process.env.TEST_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)
    : process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = useTestEnv
    ? (process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ??
        process.env.SUPABASE_SERVICE_ROLE_KEY)
    : process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Admin Supabase client requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
