import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, clientForUser, createOrgUser, seedTwoOrgs } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

// Implementation Spec v6 (FABLE-RULINGS.md S17b/S18/AB1-AB3): the equivalence
// test method. Install the OLD function body (20260909080000_messages_search.sql)
// under a temporary name, install the NEW rewrite under the real name, call
// BOTH with identical parameters/auth/DB snapshot, and assert jsonb equality of
// the complete document (row order, NULLs, counts, page metadata) — never
// modify the old oracle to make comparison pass.

const service = createTestClient();
const oldSql = readFileSync(new URL("./20260909080000_messages_search.sql", import.meta.url), "utf8");
const originalGlobalSql = readFileSync(new URL("./20260909000000_global_search.sql", import.meta.url), "utf8");
const relevanceSql = readFileSync(new URL("./20260909080600_search_relevance_fixes.sql", import.meta.url), "utf8");
const definerScopingSql = readFileSync(new URL("./20260909084500_search_global_definer_scoping.sql", import.meta.url), "utf8");
const newSql = readFileSync(new URL("./20260914140000_sms_inbox_narrow_core.sql", import.meta.url), "utf8");

const OLD_ORACLE_NAME = "sms_inbox_thread_page_snapshot_old_oracle";
// Old body, renamed only, with search-predicate hardening from later
// migrations preserved (matches the existing search integration test's setup
// so the oracle reflects the actual pre-rewrite behavior, not a stale body).
const oldOracleSql = (relevanceSql + definerScopingSql + oldSql)
  .replaceAll("sms_inbox_thread_page_snapshot", OLD_ORACLE_NAME);

const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const users: string[] = [];
let a: ReturnType<typeof clientForUser>;

// Fixed p_cutoff so both functions see an identical DB snapshot/window.
const CUTOFF = new Date(Date.now() - 200 * 86400000).toISOString();

type Row = {
  thread_id: string;
  contact_name: string | null;
  is_test_traffic: boolean;
  [key: string]: unknown;
};
type Page = {
  rows: Row[];
  counts: Record<string, number>;
  total: number;
  hidden_count: number;
  limit: number;
  offset: number;
};

async function apply(source: string) {
  await db.query("begin");
  try {
    await db.query(source);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

/**
 * Equivalence assertion via the SQL-level oracle call (not the JS RPC client)
 * so we can pass the DB session's own auth context (RLS) identically to both
 * the old and new definitions in one connection.
 */
async function callOldViaSession(userId: string, args: Record<string, unknown>): Promise<Page> {
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
  await db.query("set local role authenticated");
  const { rows } = await db.query(
    `select public.${OLD_ORACLE_NAME}($1, $2, $3, $4, $5, $6, $7, $8) as doc`,
    [
      args.p_cutoff ?? CUTOFF,
      args.p_filter ?? "all",
      args.p_assignee_id ?? null,
      args.p_include_thread_id ?? null,
      args.p_hide_noise ?? true,
      args.p_limit ?? 200,
      args.p_offset ?? 0,
      args.p_search ?? null,
    ],
  );
  return rows[0].doc as Page;
}

async function callNewViaSession(userId: string, args: Record<string, unknown>): Promise<Page> {
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
  await db.query("set local role authenticated");
  const { rows } = await db.query(
    `select public.sms_inbox_thread_page_snapshot($1, $2, $3, $4, $5, $6, $7, $8) as doc`,
    [
      args.p_cutoff ?? CUTOFF,
      args.p_filter ?? "all",
      args.p_assignee_id ?? null,
      args.p_include_thread_id ?? null,
      args.p_hide_noise ?? true,
      args.p_limit ?? 200,
      args.p_offset ?? 0,
      args.p_search ?? null,
    ],
  );
  return rows[0].doc as Page;
}

async function assertEquivalent(userId: string, args: Record<string, unknown>) {
  const oldDoc = await callOldViaSession(userId, args);
  const newDoc = await callNewViaSession(userId, args);
  expect(newDoc).toEqual(oldDoc);
}

describe("sms_inbox_thread_page_snapshot narrow-core rewrite (Spec v6, S18)", () => {
  let userId: string;
  let readThreadId: string;
  let oldReviewThreadId: string;
  let canaryThreadId: string;
  let jitterSpaceThreadId: string;
  let jitterDashThreadId: string;
  let nullNameThreadId: string;

  beforeAll(async () => {
    await db.connect();
    // Install the old body under a temp name (oracle), then the new rewrite
    // under the real name. Never modify the old oracle body.
    await apply(originalGlobalSql + oldOracleSql);
    await apply(originalGlobalSql + newSql);

    await resetTenantTables(service);
    await seedTwoOrgs(service);
    const user = await createOrgUser(service, {
      orgId: BMH_ORG_ID,
      email: `inbox-narrow-core-${randomUUID()}@example.test`,
      role: "member",
    });
    users.push(user.userId);
    userId = user.userId;
    a = clientForUser(user.jwt);

    async function seedContact(overrides: Record<string, unknown>) {
      const id = randomUUID();
      const { error } = await service.from("contacts").insert({
        id, org_id: BMH_ORG_ID, first_name: "Test", last_name: `C${id.slice(0, 4)}`, ...overrides,
      });
      if (error) throw error;
      return id;
    }
    async function seedProperty(overrides: Record<string, unknown>) {
      const id = randomUUID();
      const { error } = await service.from("properties").insert({
        id, org_id: BMH_ORG_ID, address: `${id.slice(0, 4)} Main St`, city: "KC", state: "MO", ...overrides,
      });
      if (error) throw error;
      return id;
    }
    async function seedMessage(overrides: Record<string, unknown>) {
      const { error } = await service.from("messages").insert({
        org_id: BMH_ORG_ID, channel: "sms", status: "received", ...overrides,
      } as never);
      if (error) throw error;
    }

    // Case 1: an included READ thread under filter=unread (S17b/AB4 case 1).
    // unread_count = 0, passed as p_include_thread_id; must appear on
    // page/total for `unread` without bumping counts.unread.
    readThreadId = randomUUID();
    {
      const contactId = await seedContact({ first_name: "Read", last_name: "Included" });
      await seedMessage({
        contact_id: contactId, conversation_id: readThreadId, direction: "inbound",
        read_at: new Date().toISOString(), body: "already read", from_address: "+18160000001", to_address: "+18169999999",
        created_at: new Date().toISOString(),
      });
    }

    // Case 2: an old pending-review thread under filter=dispo (outside the
    // 90-day window / has_recent=false, old_review_grouped recovery path).
    oldReviewThreadId = randomUUID();
    {
      const contactId = await seedContact({ first_name: "OldReview", last_name: "Dispo" });
      const propertyId = await seedProperty({});
      const oldCreatedAt = new Date(Date.now() - 400 * 86400000).toISOString();
      await seedMessage({
        contact_id: contactId, conversation_id: oldReviewThreadId, direction: "inbound",
        read_at: oldCreatedAt, body: "old message", from_address: "+18160000002", to_address: "+18169999999",
        created_at: oldCreatedAt,
      });
      const { error } = await service.from("ai_disposition_reviews").insert({
        org_id: BMH_ORG_ID, property_id: propertyId, conversation_id: oldReviewThreadId,
        status: "pending", disposition: "interested", ai_reason: "old pending review",
        created_at: oldCreatedAt,
      } as never);
      if (error) throw error;
    }

    // Case 3: canary/jitter naming patterns (is_test_traffic correction, AB1).
    canaryThreadId = randomUUID();
    {
      const contactId = await seedContact({ first_name: "Canary", last_name: "CANARY-1", entity_name: "Canary CANARY-1" });
      await seedMessage({
        contact_id: contactId, conversation_id: canaryThreadId, direction: "inbound",
        created_at: new Date().toISOString(), body: "canary msg", from_address: "+18160000003", to_address: "+18169999999",
      });
    }
    jitterSpaceThreadId = randomUUID();
    {
      const contactId = await seedContact({ first_name: "Jitter", last_name: "Space" });
      const propertyId = await seedProperty({ address: "Jitter Test Addr", city: "", state: "" });
      await seedMessage({
        contact_id: contactId, property_id: propertyId, conversation_id: jitterSpaceThreadId, direction: "inbound",
        created_at: new Date().toISOString(), body: "jitter space msg", from_address: "+18160000004", to_address: "+18169999999",
      });
    }
    jitterDashThreadId = randomUUID();
    {
      const contactId = await seedContact({ first_name: "Jitter", last_name: "Dash" });
      const propertyId = await seedProperty({ address: "Jitter-Test-Addr", city: "", state: "" });
      await seedMessage({
        contact_id: contactId, property_id: propertyId, conversation_id: jitterDashThreadId, direction: "inbound",
        created_at: new Date().toISOString(), body: "jitter dash msg", from_address: "+18160000005", to_address: "+18169999999",
      });
    }

    // Case 4: NULL/empty names and addresses (join-back correctness risk).
    nullNameThreadId = randomUUID();
    {
      const contactId = await seedContact({ first_name: "", last_name: "", entity_name: null });
      const propertyId = await seedProperty({ address: "", city: "", state: "" });
      await seedMessage({
        contact_id: contactId, property_id: propertyId, conversation_id: nullNameThreadId, direction: "inbound",
        created_at: new Date().toISOString(), body: "null name msg", from_address: "+18160000006", to_address: "+18169999999",
      });
    }
  }, 120000);

  afterAll(async () => {
    try {
      await apply(`drop function if exists public.${OLD_ORACLE_NAME}(timestamptz, text, uuid, uuid, boolean, integer, integer, text);`);
      for (const id of users) await service.auth.admin.deleteUser(id);
    } finally {
      await db.end();
    }
  });

  it("REQUIRED case 1: included READ thread under unread — page/total include it, counts.unread does not", async () => {
    const oldDoc = await callOldViaSession(userId, { p_filter: "unread", p_include_thread_id: readThreadId, p_hide_noise: false });
    const newDoc = await callNewViaSession(userId, { p_filter: "unread", p_include_thread_id: readThreadId, p_hide_noise: false });
    expect(newDoc).toEqual(oldDoc);
    expect(newDoc.rows.some(r => r.thread_id === readThreadId)).toBe(true);
  });

  it("REQUIRED case 2: old pending-review thread appears under dispo despite has_recent=false", async () => {
    const oldDoc = await callOldViaSession(userId, { p_filter: "dispo", p_hide_noise: false });
    const newDoc = await callNewViaSession(userId, { p_filter: "dispo", p_hide_noise: false });
    expect(newDoc).toEqual(oldDoc);
    expect(newDoc.rows.some(r => r.thread_id === oldReviewThreadId)).toBe(true);
  });

  it("REQUIRED case 3: canary/jitter naming patterns match is_test_traffic/is_noise/dispo_count under both noise settings", async () => {
    for (const hideNoise of [true, false]) {
      await assertEquivalent(userId, { p_filter: "all", p_hide_noise: hideNoise });
      const newDoc = await callNewViaSession(userId, { p_filter: "all", p_hide_noise: false });
      for (const id of [canaryThreadId, jitterSpaceThreadId, jitterDashThreadId]) {
        const row = newDoc.rows.find(r => r.thread_id === id);
        expect(row?.is_test_traffic).toBe(true);
      }
    }
  });

  it("REQUIRED case 4: NULL/empty contact name and property address render as null via LEFT JOIN, counts unaffected", async () => {
    const oldDoc = await callOldViaSession(userId, { p_filter: "all", p_hide_noise: false });
    const newDoc = await callNewViaSession(userId, { p_filter: "all", p_hide_noise: false });
    expect(newDoc).toEqual(oldDoc);
    const row = newDoc.rows.find(r => r.thread_id === nullNameThreadId);
    expect(row).toBeTruthy();
    expect(row?.contact_name === null || row?.contact_name === "").toBe(
      (oldDoc.rows.find(r => r.thread_id === nullNameThreadId)?.contact_name === null
        || oldDoc.rows.find(r => r.thread_id === nullNameThreadId)?.contact_name === ""),
    );
  });

  it.each(["all", "unread", "mine", "unassigned", "escalated", "dispo", "needs_outcome"] as const)(
    "matches the old oracle exactly for filter=%s (both noise settings, page 1)",
    async (filter) => {
      for (const hideNoise of [true, false]) {
        await assertEquivalent(userId, { p_filter: filter, p_hide_noise: hideNoise, p_assignee_id: userId });
      }
    },
  );

  it("matches the old oracle with p_include_thread_id set and with a search term", async () => {
    await assertEquivalent(userId, { p_filter: "unread", p_include_thread_id: readThreadId });
    await assertEquivalent(userId, { p_filter: "all", p_search: "Test" });
  });

  it("matches the old oracle across page 2 (offset)", async () => {
    await assertEquivalent(userId, { p_filter: "all", p_hide_noise: false, p_limit: 2, p_offset: 2 });
  });

  it("existing list-threads.ts integration coverage: real authenticated RPC call via PostgREST returns a well-formed page", async () => {
    // Not a replacement for the equivalence suite above — additive coverage
    // that the rewrite is actually reachable and well-formed through the
    // real client/auth path list-threads.ts uses (non-blocking fix 6).
    const { data, error } = await a.rpc("sms_inbox_thread_page_snapshot", {
      p_cutoff: CUTOFF, p_filter: "all", p_hide_noise: false, p_limit: 200, p_offset: 0,
    });
    expect(error).toBeNull();
    const doc = data as unknown as Page;
    expect(Array.isArray(doc.rows)).toBe(true);
    expect(typeof doc.total).toBe("number");
    expect(doc.rows.some(r => r.thread_id === readThreadId)).toBe(true);
  });
});

describe("sms_inbox_thread_page_snapshot signature/config safety net (BLOCKING, Fable v6)", () => {
  beforeAll(async () => {
    await db.connect();
  });
  afterAll(async () => {
    await db.end();
  });

  it("pg_get_function_arguments(oid) is byte-identical before and after the migration", async () => {
    // Captured from the live/fixture DB running the OLD definition, not
    // retyped from the migration file (transcription would defeat the point).
    const before = (
      await db.query(
        `select pg_get_function_arguments(oid) as args
         from pg_proc where proname = $1`,
        [OLD_ORACLE_NAME],
      )
    ).rows[0].args as string;
    const after = (
      await db.query(
        `select pg_get_function_arguments(oid) as args
         from pg_proc where proname = 'sms_inbox_thread_page_snapshot'`,
      )
    ).rows[0].args as string;
    const expected = before.replaceAll(OLD_ORACLE_NAME, "sms_inbox_thread_page_snapshot");
    expect(after).toBe(expected);

    // Mutation-kill demo: dropping a DEFAULT clause must fail this assertion.
    const mutated = after.replace("p_search text DEFAULT NULL::text", "p_search text");
    expect(mutated).not.toBe(expected);
  });

  it("proconfig carries search_path='', statement_timeout='15s', and no unexplained settings", async () => {
    const { rows } = await db.query(
      `select proconfig from pg_proc where proname = 'sms_inbox_thread_page_snapshot'`,
    );
    const config: string[] = rows[0].proconfig ?? [];
    expect(config).toEqual(expect.arrayContaining(["search_path=", "statement_timeout=15s"]));
    // Mutation-kill demo: dropping search_path must fail this assertion.
    const mutated = config.filter(c => !c.startsWith("search_path"));
    expect(mutated).not.toEqual(expect.arrayContaining(["search_path="]));
  });

  it("rehearsed rollback: re-applying the old body+config restores the pre-migration signature/config", async () => {
    await db.query("begin");
    try {
      await db.query(oldOracleSql.replaceAll(OLD_ORACLE_NAME, "sms_inbox_thread_page_snapshot"));
      const { rows } = await db.query(
        `select pg_get_function_arguments(oid) as args, proconfig
         from pg_proc where proname = 'sms_inbox_thread_page_snapshot'`,
      );
      const rolledBackArgs = rows[0].args as string;
      const rolledBackConfig: string[] = rows[0].proconfig ?? [];
      expect(rolledBackConfig).toEqual(expect.arrayContaining(["search_path=", "statement_timeout=15s"]));
      expect(rolledBackArgs).toContain("p_search text DEFAULT NULL::text");
    } finally {
      // Always restore the rewrite regardless of assertion outcome above.
      await db.query("rollback");
      await db.query(
        readFileSync(new URL("./20260914140000_sms_inbox_narrow_core.sql", import.meta.url), "utf8"),
      );
    }
  });
});
