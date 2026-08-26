import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REALTIME_SUBSCRIBE_STATES, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";
import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, clientForUser, createOrgUser, seedTwoOrgs } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

const serviceClient = createTestClient();
const createdUserIds: string[] = [];

/**
 * Replays this migration's own SQL directly against the shared
 * sandra-crm-test project before any test runs, rather than trusting
 * whatever schema the project already has.
 *
 * db-migrate-test.yml only applies migrations on push to `main` (after
 * review) — a branch's own migration file, like this one before it
 * merges, is never applied there. Without this, the pre-merge CI job that
 * runs this test file would exercise stale SQL: the `coach_call_index`
 * table and its RLS/restrictive policies as they existed the last time
 * `main` touched this area (possibly not at all), silently passing or
 * failing for the wrong reasons.
 *
 * Deliberately NOT `supabase db push` — that registers the migration in
 * `schema_migrations` and runs the full ordered migration-safety gate
 * (scripts/check-migration-safety.mjs), which is reserved for the real
 * post-merge pipeline and would let an unmerged branch's migration
 * silently take a permanent slot in the shared project's migration
 * history. This SQL file is deliberately idempotent (`create table if not
 * exists`, `drop policy if exists` before every `create policy`) so a
 * raw, repeated replay is safe — CI runs it on every PR, and any
 * developer running `npm run test:integration` locally gets the same
 * replay, so nobody needs a manual step to keep their local shared
 * project in sync with this branch's schema.
 *
 * Runs inside a test file's beforeAll (a worker process), which always
 * executes after global-setup.ts has acquired the suite's advisory lock —
 * this replay is therefore serialized against every other integration/E2E
 * run against the same shared project, not a free-for-all schema change
 * racing concurrent test runs.
 */
async function replayMigration(): Promise<void> {
  const dbUrl = process.env.TEST_SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new Error(
      "Missing TEST_SUPABASE_DB_URL — required to replay this migration before the authorization tests run. " +
        "See tests/integration/README.md.",
    );
  }
  const sql = readFileSync(path.resolve(__dirname, "20260826170000_coach_call_index.sql"), "utf8");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
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
  await replayMigration();
  await resetTenantTables(serviceClient);
  await seedTwoOrgs(serviceClient);
});

beforeEach(async () => {
  await resetTenantTables(serviceClient);
});

afterAll(async () => {
  for (const userId of createdUserIds) {
    await serviceClient.auth.admin.deleteUser(userId);
  }
  await resetTenantTables(serviceClient);
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

    await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: clientCallId, operator_user_id: owner.userId, property_id: propertyId });

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

    await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: clientCallId, operator_user_id: owner.userId, property_id: propertyA });
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
// `npm run test:integration`. It IS wired into pre-merge CI (see
// .github/workflows/verify.yml's `coach-realtime-authorization` job, added
// alongside this test) specifically because an authorization regression
// here is exactly the class of bug that must never reach `main` unreviewed.
// ----------------------------------------------------------------------------
describe("Migration 20260826170000 — coach:{client_call_id} Realtime Broadcast Authorization", () => {
  it("lets the owning operator join the private coach:{client_call_id} channel", async () => {
    const propertyId = await insertProperty();
    const owner = await createUser("owner");
    const clientCallId = crypto.randomUUID();
    await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: clientCallId, operator_user_id: owner.userId, property_id: propertyId });

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
    const clientCallId = crypto.randomUUID();
    await asIndexClient(serviceClient)
      .from("coach_call_index")
      .upsert({ client_call_id: clientCallId, operator_user_id: owner.userId, property_id: propertyId });

    other.client.realtime.setAuth(other.jwt);
    const { status, err } = await subscribeAndWaitForStatus(other.client, `coach:${clientCallId}`);
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
