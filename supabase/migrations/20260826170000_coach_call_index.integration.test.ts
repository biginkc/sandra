import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REALTIME_SUBSCRIBE_STATES, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";
import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, clientForUser, createOrgUser, seedTwoOrgs } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";
import { retryTestSetup } from "@tests/integration/retry";

const serviceClient = createTestClient();
const createdUserIds: string[] = [];

/**
 * Ensures this migration's schema exists against the shared
 * sandra-crm-test project before any test runs, rather than trusting
 * whatever schema the project already has — WITHOUT ever dropping a
 * schema this run didn't create itself.
 *
 * db-migrate-test.yml only applies migrations on push to `main` (after
 * review). Before this branch merges, that schema doesn't exist there yet
 * and this file needs to create it. AFTER this branch merges,
 * db-migrate-test.yml applies it for real and it becomes PERMANENT shared
 * schema — at that point this file must treat it exactly like any other
 * pre-existing table it didn't create, never drop/recreate it. A
 * round-5 version of this file rollback-then-replayed unconditionally on
 * every run and dropped the schema again in `afterAll`; post-merge, a
 * routine `npm run test:integration` run would have deleted the real
 * permanent `coach_call_index` table and its realtime.messages policies
 * from the shared project. That bug is exactly what the existence check
 * below exists to close.
 *
 * `ensureMigrationSchema()` checks whether `public.coach_call_index`
 * already exists. If it does, this run did NOT create it (either it's
 * already merged into `main` and permanent, or a prior run left it behind
 * intentionally) — assert its RLS/policy shape matches what this file
 * expects and STOP: never touch it further. If it doesn't exist, apply
 * this migration's SQL (idempotent — `create table if not exists`,
 * `drop policy if exists` before every `create policy` — safe even if
 * something partially applied it before) and remember that THIS run is
 * responsible for it, so `afterAll` knows it's safe (and correct) to roll
 * it back.
 *
 * Deliberately NOT `supabase db push` — that registers the migration in
 * `schema_migrations` and runs the full ordered migration-safety gate
 * (scripts/check-migration-safety.mjs), which is reserved for the real
 * post-merge pipeline and would let an unmerged branch's migration
 * silently take a permanent slot in the shared project's migration
 * history.
 *
 * Runs inside a test file's beforeAll (a worker process), which always
 * executes after global-setup.ts has acquired the suite's advisory lock —
 * this check-then-apply is therefore serialized against every other
 * integration/E2E run against the same shared project, not a free-for-all
 * schema change racing concurrent test runs.
 *
 * This file only ever runs via a developer's own `npm run test:integration`
 * — never wired into any CI job. The dedicated
 * .github/workflows/coach-realtime-authorization.yml canary applies (and,
 * pre-merge only, always rolls back) this same SQL independently, and is
 * the one that actually gates PRs.
 */
let createdSchemaThisRun = false;

async function withDbClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const dbUrl = process.env.TEST_SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new Error(
      "Missing TEST_SUPABASE_DB_URL — required to check/apply this migration before the authorization tests run. " +
        "See tests/integration/README.md.",
    );
  }
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function runSqlFile(client: Client, filename: string): Promise<void> {
  const sql = readFileSync(path.resolve(__dirname, filename), "utf8");
  await client.query(sql);
}

async function schemaAlreadyExists(client: Client): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    "select to_regclass('public.coach_call_index') is not null as exists",
  );
  return rows[0]?.exists ?? false;
}

/** Structural sanity check for schema this run did NOT create (so it's
 * never re-applied or dropped) — fails loudly rather than silently letting
 * the tests below run against a table that's missing its RLS/policies for
 * some unrelated reason. */
async function assertMigrationSchemaShape(client: Client): Promise<void> {
  const { rows } = await client.query<{
    table_rls_enabled: boolean;
    owner_select_policy_count: number;
    realtime_permissive_policy_count: number;
    realtime_restrictive_policy_count: number;
  }>(`
    select
      (select relrowsecurity from pg_class where oid = 'public.coach_call_index'::regclass) as table_rls_enabled,
      (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'coach_call_index' and policyname = 'coach_call_index_owner_select') as owner_select_policy_count,
      (select count(*)::int from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'coach_broadcast_owner_select' and permissive = 'PERMISSIVE') as realtime_permissive_policy_count,
      (select count(*)::int from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'coach_topics_require_ownership' and permissive = 'RESTRICTIVE') as realtime_restrictive_policy_count
  `);
  const shape = rows[0];
  if (
    !shape?.table_rls_enabled ||
    shape.owner_select_policy_count !== 1 ||
    shape.realtime_permissive_policy_count !== 1 ||
    shape.realtime_restrictive_policy_count !== 1
  ) {
    throw new Error(
      `coach_call_index already exists but its RLS/policy shape doesn't match this migration file: ${JSON.stringify(shape)}. ` +
        "This test never touches (re-applies or drops) schema it didn't create this run — fix the shared project's schema directly instead.",
    );
  }
}

async function ensureMigrationSchema(): Promise<void> {
  await withDbClient(async (client) => {
    if (await schemaAlreadyExists(client)) {
      // Not created by this run — permanent (post-merge) or intentionally
      // left by someone else. Verify it, then never touch it again.
      await assertMigrationSchemaShape(client);
      createdSchemaThisRun = false;
      return;
    }
    await runSqlFile(client, "20260826170000_coach_call_index.sql");
    createdSchemaThisRun = true;
  });
}

async function rollbackMigrationIfCreatedThisRun(): Promise<void> {
  if (!createdSchemaThisRun) return; // never drop schema this run didn't create
  await withDbClient((client) =>
    runSqlFile(client, "../rollbacks/20260826170000_coach_call_index.sql"),
  );
}

// coach_call_index isn't in the generated Database type yet (it can only be
// regenerated against the live schema after this migration is applied) —
// narrow-cast for this test file, matching the repo's existing pattern for
// pre-regen tables (see tests/integration/fixtures/multi-user.ts's
// MembershipWriter).
type CoachCallIndexRow = { client_call_id: string; operator_user_id: string; property_id: string | null };
type CoachCallIndexClient = {
  from(table: "coach_call_index"): {
    upsert(values: Omit<CoachCallIndexRow, "property_id"> & { property_id?: string | null }): Promise<{
      error: { message: string } | null;
    }>;
    select(columns: "client_call_id"): {
      eq(column: "client_call_id", value: string): Promise<{
        data: { client_call_id: string }[] | null;
        error: { message: string } | null;
      }>;
    };
  };
};

function asIndexClient(client: SupabaseClient<Database>): CoachCallIndexClient {
  return client as unknown as CoachCallIndexClient;
}

function uniqueEmail(label: string): string {
  return `coach-call-index-${label}-${Date.now()}-${crypto.randomUUID()}@bmhgroupkc.com`;
}

async function createUser(label: string) {
  const user = await createOrgUser(serviceClient, { orgId: BMH_ORG_ID, email: uniqueEmail(label), role: "member" });
  createdUserIds.push(user.userId);
  return { ...user, client: clientForUser(user.jwt) };
}

async function insertProperty(): Promise<string> {
  const { data, error } = await serviceClient
    .from("properties")
    .insert({
      org_id: BMH_ORG_ID,
      address: `coach-call-index ${crypto.randomUUID()}`,
      state: "MO",
      status: "new_lead",
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return data!.id;
}

beforeAll(async () => {
  await ensureMigrationSchema();
  await retryTestSetup(() => resetTenantTables(serviceClient));
  await seedTwoOrgs(serviceClient);
});

beforeEach(async () => {
  await retryTestSetup(() => resetTenantTables(serviceClient));
});

afterAll(async () => {
  const cleanupErrors: string[] = [];
  for (const userId of createdUserIds) {
    const { error } = await serviceClient.auth.admin.deleteUser(userId);
    if (error) cleanupErrors.push(`delete auth user ${userId}: ${error.message}`);
  }
  try {
    await retryTestSetup(() => resetTenantTables(serviceClient));
  } catch (error) {
    cleanupErrors.push(`reset tenant tables: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await rollbackMigrationIfCreatedThisRun();
  } catch (error) {
    cleanupErrors.push(`rollback coach migration: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (cleanupErrors.length > 0) throw new Error(`coach authorization cleanup failed: ${cleanupErrors.join("; ")}`);
});

describe("Migration 20260826170000 — coach_call_index (coach realtime authorization)", () => {
  it("accepts a service-role upsert and lets the owning operator read their own row", async () => {
    const propertyId = await insertProperty();
    const owner = await createUser("owner");
    const clientCallId = crypto.randomUUID();

    const { error: upsertError } = await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: clientCallId, operator_user_id: owner.userId, property_id: propertyId });
    expect(upsertError).toBeNull();

    const { data, error } = await asIndexClient(owner.client)
      .from("coach_call_index")
      .select("client_call_id")
      .eq("client_call_id", clientCallId);
    expect(error).toBeNull();
    expect(data).toEqual([{ client_call_id: clientCallId }]);
  });

  it("hides another operator's call index row — the exact ownership check the coach realtime.messages policy reuses", async () => {
    const propertyId = await insertProperty();
    const owner = await createUser("owner");
    const other = await createUser("other");
    const clientCallId = crypto.randomUUID();

    const { error: upsertError } = await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: clientCallId, operator_user_id: owner.userId, property_id: propertyId });
    expect(upsertError).toBeNull();

    const { data, error } = await asIndexClient(other.client)
      .from("coach_call_index")
      .select("client_call_id")
      .eq("client_call_id", clientCallId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("refuses a direct authenticated insert — only the service-role start-call path may write", async () => {
    const owner = await createUser("owner");
    const { error } = await asIndexClient(owner.client)
      .from("coach_call_index")
      .upsert({ client_call_id: crypto.randomUUID(), operator_user_id: owner.userId, property_id: null });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/permission denied|row-level security/i);
  });

  it("upsert on conflict updates the row in place (idempotent re-mint of the same client_call_id)", async () => {
    const propertyA = await insertProperty();
    const propertyB = await insertProperty();
    const owner = await createUser("owner");
    const clientCallId = crypto.randomUUID();

    const { error: firstUpsertError } = await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: clientCallId, operator_user_id: owner.userId, property_id: propertyA });
    expect(firstUpsertError).toBeNull();
    const { error } = await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: clientCallId, operator_user_id: owner.userId, property_id: propertyB });
    expect(error).toBeNull();

    const { data } = await asIndexClient(owner.client)
      .from("coach_call_index")
      .select("client_call_id")
      .eq("client_call_id", clientCallId);
    expect(data).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// Realtime Broadcast Authorization — actually joins the private
// `coach:{client_call_id}` channel as an owner and as a non-owner, rather
// than only exercising the ownership-index table the policy's subquery
// reads from. This is the one test in the suite that talks to Realtime
// directly (there's no prior pattern for it in this repo), so it's kept in
// its own describe block with a longer timeout — private-channel join
// authorization round-trips through the Supavisor/Realtime auth path, not
// just a Postgres query.
//
// NOT run by the pre-commit hook or the default `npm run verify` — only by
// `npm run test:integration`. A minimal equivalent is wired into pre-merge
// CI by .github/workflows/coach-realtime-authorization.yml specifically
// because an authorization regression here is exactly the class of bug that
// must never reach `main` unreviewed.
// ----------------------------------------------------------------------------
describe("Migration 20260826170000 — coach:{client_call_id} Realtime Broadcast Authorization", () => {
  it("lets the owning operator join the private coach:{client_call_id} channel", async () => {
    const propertyId = await insertProperty();
    const owner = await createUser("owner");
    const clientCallId = crypto.randomUUID();
    const { error: upsertError } = await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: clientCallId, operator_user_id: owner.userId, property_id: propertyId });
    expect(upsertError).toBeNull();

    // REST calls (asIndexClient above) authorize via the Authorization
    // header baked into clientForUser. The Realtime websocket is a
    // separate connection that needs its own auth handshake — this
    // mirrors exactly what use-coach-channel.ts does before subscribing.
    owner.client.realtime.setAuth(owner.jwt);
    const { status } = await subscribeAndWaitForStatus(owner.client, `coach:${clientCallId}`);
    expect(status).toBe(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED);
    await owner.client.removeAllChannels();
  }, 20_000);

  it("denies a non-owner joining the same private coach:{client_call_id} channel — the RLS policy this migration exists for", async () => {
    const propertyId = await insertProperty();
    const owner = await createUser("owner");
    const other = await createUser("other");
    const foreignCallId = crypto.randomUUID();
    const ownedCallId = crypto.randomUUID();
    const { error: foreignUpsertError } = await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: foreignCallId, operator_user_id: owner.userId, property_id: propertyId });
    expect(foreignUpsertError).toBeNull();
    const { error: ownedUpsertError } = await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: ownedCallId, operator_user_id: other.userId, property_id: propertyId });
    expect(ownedUpsertError).toBeNull();

    other.client.realtime.setAuth(other.jwt);
    // Positive control on the same client and websocket: a generic channel,
    // socket, or auth failure would make CHANNEL_ERROR meaningless as RLS
    // evidence. Keep this owned channel open while joining the foreign one.
    const owned = await subscribeAndWaitForStatus(other.client, `coach:${ownedCallId}`);
    expect(owned.status).toBe(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED);

    const { status, err } = await subscribeAndWaitForStatus(other.client, `coach:${foreignCallId}`);
    // Require the SPECIFIC authorization-denied shape, not any non-
    // SUBSCRIBED status. TIMED_OUT/CLOSED are network/timing failures a
    // flaky run could produce for unrelated reasons and would pass this
    // assertion as a false "denied" — only CHANNEL_ERROR is what
    // Realtime's own client (RealtimeChannel.js: the join's `.receive
    // ('error', ...)` branch) uses to report the join request itself
    // being rejected, which is what an RLS policy denial actually
    // produces. `err` carries the server's rejection detail — asserting
    // it's non-empty proves this was a real reported denial, not (say) a
    // status the mock/harness produced with no underlying cause.
    expect(status).toBe(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message.length).toBeGreaterThan(0);
    await other.client.removeAllChannels();
  }, 20_000);
});

/**
 * Subscribes to a private Realtime Broadcast channel and resolves on the
 * first terminal subscribe status (SUBSCRIBED, or a failure status —
 * CHANNEL_ERROR/TIMED_OUT/CLOSED), along with the error object the
 * client's subscribe callback receives (only ever populated for
 * CHANNEL_ERROR — see RealtimeChannel.js's `.subscribe()`, which passes
 * an `Error` built from the join's rejection payload). The caller must
 * have already called `client.realtime.setAuth(jwt)` — subscribing
 * without it always fails, authorized or not, since the private-channel
 * auth handshake has nothing to check.
 */
function subscribeAndWaitForStatus(
  client: SupabaseClient<Database>,
  topic: string,
  timeoutMs = 15_000,
): Promise<{ status: REALTIME_SUBSCRIBE_STATES; err?: Error }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for a subscribe status on "${topic}".`));
    }, timeoutMs);
    client.channel(topic, { config: { private: true } }).subscribe((status, err) => {
      if (
        status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED ||
        status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
        status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ||
        status === REALTIME_SUBSCRIBE_STATES.CLOSED
      ) {
        clearTimeout(timer);
        resolve({ status, err });
      }
    });
  });
}
