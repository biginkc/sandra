import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

/**
 * Build a Supabase client for integration tests. Uses the service-role
 * key so tests can bypass RLS for setup / teardown / assertions against
 * every row in the tenant tables.
 *
 * Never imported from application code. Never given a real user JWT.
 * Points at the `sandra-crm-test` project (ncsngxlcyxylaeskiteu) via
 * env vars loaded by `vitest.integration.config.ts` from `.env.test.local`.
 */
export function createTestClient(): SupabaseClient<Database> {
  const url = process.env.TEST_SUPABASE_URL;
  const key = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing TEST_SUPABASE_URL or TEST_SUPABASE_SERVICE_ROLE_KEY. " +
        "Check .env.test.local — see tests/integration/README.md.",
    );
  }
  // Hard guard against accidentally pointing at the dev project. If
  // `.env.test.local` ever gets copied wrong and lands on the dev URL,
  // refuse to run — a test reset would nuke real data.
  if (url.includes("copflsklaefwzipsrjqz")) {
    throw new Error(
      "TEST_SUPABASE_URL points at the dev project — refusing to run tests.",
    );
  }
  return createClient<Database>(url, key, {
    auth: {
      // No session persistence — each test client is stateless.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
