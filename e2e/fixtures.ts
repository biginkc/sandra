import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../src/lib/supabase/types";
import { assertSafeE2ESupabaseTarget } from "../src/lib/supabase/e2e-target-safety";
import {
  MOCK_PROVIDER_CAMPAIGN_ID,
  MOCK_SENDER_PRIMARY,
  MOCK_SENDER_SECONDARY,
  seedProviderCampaignCatalog,
  seedSenderCatalog,
} from "../tests/integration/delivery";

/**
 * Helpers shared across E2E specs. Everything here runs OUT OF BAND from
 * Playwright's browser context — it talks to Supabase via service-role
 * so we can reset tables, seed fixtures, and pre-provision the test user
 * without going through the UI.
 */

export const TEST_USER_EMAIL = "e2e-test@bmhgroupkc.com";
export const TEST_USER_PASSWORD = "test12345";
export const E2E_MOCK_BUSINESS_NUMBER = MOCK_SENDER_PRIMARY;

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
  assertSafeE2ESupabaseTarget(url, {
    allowLocal: process.env.E2E_ALLOW_LOCAL_SUPABASE === "1",
  });
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Truncate every tenant-data table via the SECURITY DEFINER RPC. */
export async function resetTenantTables(
  client: SupabaseClient<Database>,
): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { error } = await client.rpc("reset_tenant_tables");
    if (!error) {
      await deleteTenantCoreRows(client);
      await seedMockDeliveryCatalog(client);
      return;
    }

    const retryable =
      error.code === "40P01" || error.message.includes("deadlock detected");
    if (!retryable || attempt === maxAttempts) {
      throw new Error(`reset_tenant_tables() failed: ${error.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
}

async function deleteAllRows(
  client: SupabaseClient<Database>,
  table: "messages" | "notifications" | "properties" | "contacts",
): Promise<void> {
  const { error } = await client.from(table).delete().not("id", "is", null);
  if (error) {
    throw new Error(
      `reset_tenant_tables() failed to clear ${table}: ${error.message}`,
    );
  }
}

async function deleteTenantCoreRows(
  client: SupabaseClient<Database>,
): Promise<void> {
  await deleteAllRows(client, "messages");
  await deleteAllRows(client, "notifications");

  const { error: unlinkContactsError } = await client
    .from("properties")
    .update({
      homeowner_contact_id: null,
      agent_contact_id: null,
    })
    .not("id", "is", null);
  if (unlinkContactsError) {
    throw new Error(
      `reset_tenant_tables() failed to unlink property contacts: ${unlinkContactsError.message}`,
    );
  }

  await deleteAllRows(client, "contacts");
  await deleteAllRows(client, "properties");
}

async function seedMockDeliveryCatalog(
  client: SupabaseClient<Database>,
): Promise<void> {
  await seedSenderCatalog(client, DEFAULT_ORG_ID, [
    MOCK_SENDER_PRIMARY,
    MOCK_SENDER_SECONDARY,
  ]);
  await seedProviderCampaignCatalog(client, DEFAULT_ORG_ID, [
    MOCK_PROVIDER_CAMPAIGN_ID,
  ]);
}

/**
 * Default BMH organization id from migration 054 (memberships + RLS rewrite).
 * Stage 1 introduced membership-scoped RLS — without a membership row in
 * this org, the test user can't read or write tenant data.
 */
export const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000bbb";

/**
 * Ensure the shared E2E user exists in auth.users, can sign in with the shared
 * test password, AND has an "owner" membership in the default BMH org.
 * Idempotent — returns the user's id whether it was found or created.
 *
 * The membership repair is load-bearing post-Stage 1: a freshly-created test
 * user is created AFTER `reset_tenant_tables()` snapshots memberships, so the
 * snapshot's restore phase has nothing to put back. Without the explicit
 * upsert here, RLS would block every subsequent read/write the test
 * performs as that user.
 */
export async function ensureTestUser(
  client: SupabaseClient<Database>,
  options: { repairPassword?: boolean } = {},
): Promise<string> {
  // Paginate the FULL user list (Codex month-view round 4): the shared
  // test project accumulates users faster than a single 200-row page —
  // when the shared account fell past page one, this helper concluded it
  // didn't exist, tried to create the duplicate email on every run, and
  // turned the whole E2E job red. Page size 1000 with a hard page cap;
  // never trust data.nextPage for the loop bound (auth-js multi-digit
  // page parsing bug — same locally-bounded pattern as
  // fetchAssigneeEmails).
  const MAX_USER_PAGES = 50;
  let existing: { id: string } | undefined;
  for (let page = 1; page <= MAX_USER_PAGES && !existing; page++) {
    const { data: list, error: listErr } = await client.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (listErr) throw listErr;
    const users = list?.users ?? [];
    existing = users.find((u) => u.email === TEST_USER_EMAIL);
    if (users.length < 1000) break;
  }

  let userId: string;
  if (existing) {
    userId = existing.id;
    if (options.repairPassword) {
      const { error: updateErr } = await client.auth.admin.updateUserById(
        userId,
        {
          password: TEST_USER_PASSWORD,
          email_confirm: true,
        },
      );
      if (updateErr) throw updateErr;
    }
  } else {
    const { data: created, error: createErr } =
      await client.auth.admin.createUser({
        email: TEST_USER_EMAIL,
        password: TEST_USER_PASSWORD,
        email_confirm: true,
      });
    if (createErr || !created?.user)
      throw createErr ?? new Error("createUser returned no user");
    userId = created.user.id;
  }

  // Verify-or-repair the membership row. Real upsert: insert if missing,
  // UPDATE role to "owner" if a row exists with a different role. We need
  // owner because some e2e paths (admin actions, webhook consumers) are
  // owner-gated post-Stage 1, and a stale "member" row would silently
  // block them.
  //
  // Cast through a narrow writer interface because the generated Database
  // types haven't been regenerated for memberships yet — same pattern as
  // src/lib/auth/memberships.ts.
  type MembershipWriter = {
    from(table: "memberships"): {
      upsert(
        values: { user_id: string; org_id: string; role: "owner" | "member" },
        options?: { onConflict?: string },
      ): Promise<{ error: { message: string } | null }>;
    };
  };
  const { error: membershipErr } = await (client as unknown as MembershipWriter)
    .from("memberships")
    .upsert(
      { user_id: userId, org_id: DEFAULT_ORG_ID, role: "owner" },
      { onConflict: "user_id,org_id" },
    );
  if (membershipErr) {
    throw new Error(
      `ensureTestUser: failed to upsert membership for ${TEST_USER_EMAIL}: ${membershipErr.message}`,
    );
  }

  return userId;
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
