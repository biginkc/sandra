import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../src/lib/supabase/types";
import {
  assertExistingUserMatchesIdentity,
  ensureE2ERunEnvironment,
  identityForPrincipal,
  type E2EPrincipal,
} from "../src/lib/supabase/e2e-identity-guard";
import { assertSafeE2ESupabaseTargetFromEnvironment } from "../src/lib/supabase/e2e-target-safety";
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

const E2E_RUN_ENVIRONMENT = ensureE2ERunEnvironment();
const PRIMARY_E2E_IDENTITY = identityForPrincipal(E2E_RUN_ENVIRONMENT);

export const TEST_USER_EMAIL = PRIMARY_E2E_IDENTITY.email;
export const TEST_USER_PASSWORD = PRIMARY_E2E_IDENTITY.password;
export const TEST_ASSIGNEE_EMAIL = identityForPrincipal(
  E2E_RUN_ENVIRONMENT,
  "assignee",
).email;
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
  assertSafeE2ESupabaseTargetFromEnvironment(url);
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
 * Ensure this run's namespaced E2E user exists in auth.users, can sign in with
 * the one job-scoped password, AND has the requested membership in the default
 * BMH org.
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
  options: {
    principal?: E2EPrincipal;
    membershipRole?: "owner" | "member";
  } = {},
): Promise<string> {
  const identity = identityForPrincipal(
    E2E_RUN_ENVIRONMENT,
    options.principal ?? "primary",
  );
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
    existing = users.find(
      (user) => user.email?.trim().toLowerCase() === identity.email,
    );
    if (users.length < 1000) break;
  }

  let userId: string;
  if (existing) {
    assertExistingUserMatchesIdentity(existing, identity);
    userId = existing.id;
  } else {
    const { data: created, error: createErr } =
      await client.auth.admin.createUser({
        email: identity.email,
        password: identity.password,
        email_confirm: true,
        app_metadata: identity.appMetadata,
      });
    if (createErr || !created?.user)
      throw createErr ?? new Error("createUser returned no user");
    assertExistingUserMatchesIdentity(created.user, identity);
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
      {
        user_id: userId,
        org_id: DEFAULT_ORG_ID,
        role: options.membershipRole ?? "owner",
      },
      { onConflict: "user_id,org_id" },
    );
  if (membershipErr) {
    throw new Error(
      `ensureTestUser: failed to upsert the run-scoped membership: ${membershipErr.message}`,
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

/**
 * Org-scoped cleanup for the inbox acceptance harness (Astra #8).
 *
 * `resetTenantTables()` / `deleteTenantCoreRows()` above are an
 * ORG-UNSCOPED broad delete — every row in messages/notifications/
 * properties/contacts, regardless of org_id. That's fine for specs that
 * own the whole shared fixture DB for their run, but it's a hazard for a
 * harness that must coexist with other proofs touching the same shared
 * fixture: a stray call would blow away rows seeded by an unrelated org.
 *
 * This variant deletes ONLY rows scoped to the given org_id (defaults to
 * DEFAULT_ORG_ID, the harness's fixture org). Today this test project is
 * single-tenant (every row uses DEFAULT_ORG_ID = SANDRA_ORG_ID), so an
 * org_id-scoped delete and a full-table delete affect the same rows right
 * now — the value is contractual, not yet behavioral: it stops being a
 * silent full-table wipe the moment a second org_id ever appears in this
 * fixture, and it makes the acceptance harness's own cleanup call explicit
 * about what it owns instead of reaching for the broad RPC. It does NOT
 * touch `resetTenantTables`'s signature or behavior — this is a new,
 * additive helper for e2e/inbox-acceptance/* callers only.
 */
export async function deleteOrgScopedFixtureRows(
  client: SupabaseClient<Database>,
  orgId: string = DEFAULT_ORG_ID,
): Promise<void> {
  const deleteScoped = async (
    table: "messages" | "notifications",
  ): Promise<void> => {
    const { error } = await client.from(table).delete().eq("org_id", orgId);
    if (error) {
      throw new Error(
        `deleteOrgScopedFixtureRows: failed to clear ${table} for org ${orgId}: ${error.message}`,
      );
    }
  };

  await deleteScoped("messages");
  await deleteScoped("notifications");

  // lead_events is an append-only audit ledger by design (see migration
  // 20260825170000_lead_events_ledger.sql: service_role is GRANTed only
  // select+insert on it, never delete/update — the only privileged path
  // that can truncate it is the reset_tenant_tables() RPC's SECURITY
  // DEFINER body). Actions this harness exercises (e.g. releaseMessage)
  // record a lead_event automatically. Deleting it directly is not just
  // unauthorized, it would be wrong: this cleanup must not undermine the
  // ledger's intentional immutability. Any property still referenced by a
  // lead_event for this org is therefore left in place below instead of
  // being force-deleted — the harness's fixture properties are otherwise
  // inert (no PII, address-only rows), so this residue is a known,
  // accepted byproduct of exercising a real send/dispo action, not a
  // fixture leak.
  const { data: retainedProperties, error: leadEventsReadError } = await client
    .from("lead_events")
    .select("property_id")
    .eq("org_id", orgId);
  if (leadEventsReadError) {
    throw new Error(
      `deleteOrgScopedFixtureRows: failed to read lead_events for org ${orgId}: ${leadEventsReadError.message}`,
    );
  }
  const retainedPropertyIds = [...new Set((retainedProperties ?? []).map((row) => row.property_id))];

  // Unlink property <-> contact references within this org only before
  // deleting contacts, mirroring deleteTenantCoreRows' ordering so FK
  // constraints never block the delete below.
  const { error: unlinkError } = await client
    .from("properties")
    .update({ homeowner_contact_id: null, agent_contact_id: null })
    .eq("org_id", orgId);
  if (unlinkError) {
    throw new Error(
      `deleteOrgScopedFixtureRows: failed to unlink property contacts for org ${orgId}: ${unlinkError.message}`,
    );
  }

  const { error: contactsError } = await client
    .from("contacts")
    .delete()
    .eq("org_id", orgId);
  if (contactsError) {
    throw new Error(
      `deleteOrgScopedFixtureRows: failed to clear contacts for org ${orgId}: ${contactsError.message}`,
    );
  }

  let propertiesQuery = client.from("properties").delete().eq("org_id", orgId);
  if (retainedPropertyIds.length > 0) {
    propertiesQuery = propertiesQuery.not(
      "id",
      "in",
      `(${retainedPropertyIds.join(",")})`,
    );
  }
  const { error: propertiesError } = await propertiesQuery;
  if (propertiesError) {
    throw new Error(
      `deleteOrgScopedFixtureRows: failed to clear properties for org ${orgId}: ${propertiesError.message}`,
    );
  }
}

/**
 * Count rows still scoped to `orgId` across the four core tenant tables.
 * The acceptance harness uses this immediately after
 * `deleteOrgScopedFixtureRows` to assert its own seeded rows are gone
 * without needing to assert anything about other orgs' rows.
 *
 * `properties` rows still referenced by a `lead_events` row are excluded
 * from this count — deleteOrgScopedFixtureRows deliberately leaves those
 * in place (lead_events is an append-only ledger service_role cannot
 * delete; see the comment there), so counting them here would make a
 * correctly-behaving cleanup look broken.
 */
export async function countOrgScopedFixtureRows(
  client: SupabaseClient<Database>,
  orgId: string = DEFAULT_ORG_ID,
): Promise<number> {
  const { data: retainedProperties, error: leadEventsError } = await client
    .from("lead_events")
    .select("property_id")
    .eq("org_id", orgId);
  if (leadEventsError) {
    throw new Error(
      `countOrgScopedFixtureRows: failed to read lead_events for org ${orgId}: ${leadEventsError.message}`,
    );
  }
  const retainedPropertyIds = [...new Set((retainedProperties ?? []).map((row) => row.property_id))];

  let total = 0;
  for (const table of [
    "messages",
    "notifications",
    "contacts",
    "properties",
  ] as const) {
    let query = client
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId);
    if (table === "properties" && retainedPropertyIds.length > 0) {
      query = query.not("id", "in", `(${retainedPropertyIds.join(",")})`);
    }
    const { count, error } = await query;
    if (error) {
      throw new Error(
        `countOrgScopedFixtureRows: failed to count ${table} for org ${orgId}: ${error.message}`,
      );
    }
    total += count ?? 0;
  }
  return total;
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
