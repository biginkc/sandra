import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../src/lib/supabase/types";

/**
 * Helpers shared across E2E specs. Everything here runs OUT OF BAND from
 * Playwright's browser context — it talks to Supabase via service-role
 * so we can reset tables, seed fixtures, and pre-provision the test user
 * without going through the UI.
 */

export const TEST_USER_EMAIL = "claude@test.com";
export const TEST_USER_PASSWORD = "test12345";

export function adminClient(): SupabaseClient<Database> {
  const url =
    process.env.TEST_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key =
    process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    "";
  if (!url || !key) {
    throw new Error(
      "E2E fixtures need TEST_SUPABASE_URL + TEST_SUPABASE_SERVICE_ROLE_KEY in the environment.",
    );
  }
  if (url.includes("copflsklaefwzipsrjqz")) {
    throw new Error(
      "E2E fixtures refusing to run against the dev project — would trash data.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Truncate every tenant-data table via the SECURITY DEFINER RPC. */
export async function resetTenantTables(
  client: SupabaseClient<Database>,
): Promise<void> {
  const { error } = await client.rpc("reset_tenant_tables");
  if (error) throw new Error(`reset_tenant_tables() failed: ${error.message}`);
}

/**
 * Ensure `claude@test.com` exists in auth.users and can sign in with the
 * shared test password. Idempotent — returns the existing user's id if
 * already present, otherwise creates and confirms it.
 */
export async function ensureTestUser(
  client: SupabaseClient<Database>,
): Promise<string> {
  const { data: list, error: listErr } = await client.auth.admin.listUsers({
    perPage: 200,
  });
  if (listErr) throw listErr;
  const existing = list?.users.find((u) => u.email === TEST_USER_EMAIL);
  if (existing) return existing.id;

  const { data: created, error: createErr } =
    await client.auth.admin.createUser({
      email: TEST_USER_EMAIL,
      password: TEST_USER_PASSWORD,
      email_confirm: true,
    });
  if (createErr || !created?.user)
    throw createErr ?? new Error("createUser returned no user");
  return created.user.id;
}

export type SeededProspect = {
  id: string;
  address: string;
};

/** Insert N prospects with deterministic addresses. Returns their ids. */
export async function seedProspects(
  client: SupabaseClient<Database>,
  count: number,
  addressPrefix = "E2E",
): Promise<SeededProspect[]> {
  const rows = Array.from({ length: count }, (_, i) => ({
    address: `${addressPrefix} ${i + 1} Golden Path Ln`,
    state: "MO",
    status: "prospect",
    cass_status: "verified",
    market: "Kansas City",
    city: "Kansas City",
    zip: "64151",
  }));
  const { data, error } = await client
    .from("properties")
    .insert(rows)
    .select("id, address");
  if (error || !data) throw error ?? new Error("seedProspects failed");
  return data.map((r) => ({ id: r.id, address: r.address }));
}

export async function seedList(
  client: SupabaseClient<Database>,
  name: string,
): Promise<string> {
  const { data, error } = await client
    .from("lists")
    .insert({ name })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedList failed");
  return data.id;
}
