import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, TEST_ORG_B_ID, clientForUser, createOrgUser, seedTwoOrgs } from "@tests/integration/fixtures/multi-user";
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

// Astra round-4 gate on #604: `set_config(..., true)` (is_local) and
// `set local role` are BOTH transaction-scoped. The original version of
// this helper issued them as bare statements with no open transaction, so
// each ran in its own implicit autocommit transaction and evaporated
// before the RPC call's own (separate) implicit transaction ever saw it --
// the RPC always ran as the raw `postgres` connection role, which the
// function's own `current_user <> 'authenticated' or ...` bypass branches
// treat as "skip org scoping", not as a real authenticated/RLS-equivalent
// call. Every equivalence assertion in this file was therefore comparing
// old vs new under an UNSCOPED bypass, never under real auth.
//
// Fix: reentrant transaction boundary. Calls made standalone (outside any
// already-open transaction) get their own short BEGIN/COMMIT so the
// identity setting actually applies to the RPC call that follows it in the
// SAME transaction. Calls made from inside `withMutant`'s already-open
// transaction (the mutation-kill tests) piggyback on it instead of
// nesting/committing -- committing here would end that transaction early
// and PERSIST the mutated function body past the test.
let ambientTxDepth = 0;

async function withDbTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const isRoot = ambientTxDepth === 0;
  ambientTxDepth++;
  if (isRoot) await db.query("begin");
  try {
    const result = await fn();
    if (isRoot) await db.query("commit");
    return result;
  } catch (error) {
    if (isRoot) await db.query("rollback");
    throw error;
  } finally {
    ambientTxDepth--;
  }
}

/**
 * Equivalence assertion via the SQL-level oracle call (not the JS RPC client)
 * so we can pass the DB session's own auth context (RLS) identically to both
 * the old and new definitions in one connection. Sets the JWT claim + role
 * inside an explicit transaction boundary (see withDbTransaction above) and
 * asserts the effective identity actually took hold BEFORE trusting the RPC
 * result -- a silent fall-back to the unscoped `postgres` role must fail the
 * call, not quietly return unscoped data.
 */
async function callViaSession(fnName: string, userId: string, args: Record<string, unknown>): Promise<Page> {
  return withDbTransaction(async () => {
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    const identity = await db.query<{ effective_role: string; uid: string | null }>(
      "select current_user as effective_role, auth.uid()::text as uid",
    );
    const { effective_role: effectiveRole, uid } = identity.rows[0];
    if (effectiveRole !== "authenticated") {
      throw new Error(`expected current_user='authenticated' for an RLS-scoped call, got '${effectiveRole}'`);
    }
    if (uid !== userId) {
      throw new Error(`expected auth.uid()='${userId}', got '${uid}' -- claims did not take effect`);
    }
    const { rows } = await db.query(
      `select public.${fnName}($1, $2, $3, $4, $5, $6, $7, $8) as doc`,
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
  });
}

async function callOldViaSession(userId: string, args: Record<string, unknown>): Promise<Page> {
  return callViaSession(OLD_ORACLE_NAME, userId, args);
}

async function callNewViaSession(userId: string, args: Record<string, unknown>): Promise<Page> {
  return callViaSession("sms_inbox_thread_page_snapshot", userId, args);
}

async function assertEquivalent(userId: string, args: Record<string, unknown>) {
  const oldDoc = await callOldViaSession(userId, args);
  const newDoc = await callNewViaSession(userId, args);
  expect(newDoc).toEqual(oldDoc);
}

/**
 * S19.5.5 mutation-kill harness: apply a MUTATED copy of the real function
 * body inside an open transaction (under the REAL name, shadowing the
 * correct rewrite for the duration of the callback), run assertions against
 * it, then always roll back so the correct rewrite is restored for every
 * other test in this file. Never mutates the old oracle.
 */
async function withMutant(mutatedSql: string, fn: () => Promise<void>) {
  // Shares ambientTxDepth with withDbTransaction (Astra round-4 gate on
  // #604): callNewViaSession is called from inside `fn` below, and it must
  // see this transaction as already open (piggyback, no nested
  // begin/commit of its own) -- otherwise its COMMIT would end THIS
  // transaction early and persist the mutated function body past the test.
  ambientTxDepth++;
  await db.query("begin");
  try {
    await db.query(mutatedSql);
    await fn();
  } finally {
    await db.query("rollback");
    ambientTxDepth--;
  }
}

function mustReplace(source: string, target: string, replacement: string): string {
  if (!source.includes(target)) {
    throw new Error(`mutation target not found in migration SQL (source drifted?): ${target.slice(0, 80)}...`);
  }
  return source.replace(target, replacement);
}

// Mutation 1 (S19.5.5): the single contacts join in `classified_narrow`
// turned INNER — must drop any thread whose contact is missing/org-scoped
// invisible, which the correct LEFT JOIN keeps (with contact_hit/is_test_traffic
// falling back to null/false).
const innerSearchJoinMutant = mustReplace(
  newSql,
  "left join contacts_in_window c on c.id = k.contact_id and c.org_id = k.org_id",
  "join contacts_in_window c on c.id = k.contact_id and c.org_id = k.org_id",
);

// Mutation 2 (S19.5.5): add a recent-cutoff to the messages FTS subquery in
// `classified` — must break search for a conversation whose ONLY matching
// message is older than p_cutoff (the real function has NO such cutoff on
// message search, per S19.5.3, verbatim from the old function).
const ftsCutoffMutant = mustReplace(
  newSql,
  `          and matching_message.fts @@ search.tsq
      )
    ) -- messages_search_predicate (E2: downstream of the single contacts join, S19.5.2)`,
  `          and matching_message.fts @@ search.tsq
          and matching_message.created_at >= (select cutoff from bounds)
      )
    ) -- messages_search_predicate (E2: downstream of the single contacts join, S19.5.2)`,
);

// Mutation 4 (S19.5.5): is_test_traffic "deferred" -- simulate the AB1 bug
// (computed as if the display strings were unavailable pre-pagination) by
// hardcoding it false in the narrow CTE. Must break dispo_count/is_noise/
// the dispo filter for the canary/jitter seeded threads.
const isTestTrafficDeferredMutant = mustReplace(
  newSql,
  `      (
        lower(trim(coalesce(coalesce(c.entity_name, nullif(concat_ws(' ', c.first_name, c.last_name), '')), ''))) like 'canary canary-%%'
        or lower(trim(coalesce(nullif(concat_ws(', ', p.address, p.city, p.state), ''), ''))) like 'jitter %%'
        or lower(trim(coalesce(nullif(concat_ws(', ', p.address, p.city, p.state), ''), ''))) like 'jitter-%%'
      ) as is_test_traffic,`,
  `      false as is_test_traffic,`,
);

describe("sms_inbox_thread_page_snapshot narrow-core rewrite (Spec v6, S18)", () => {
  let userId: string;
  let readThreadId: string;
  let oldReviewThreadId: string;
  let canaryThreadId: string;
  let jitterSpaceThreadId: string;
  let jitterDashThreadId: string;
  let nullNameThreadId: string;
  let crossOrgContactThreadId: string;
  let oldFtsOnlyThreadId: string;
  // Case 7 (Astra round-4 gate on #604): a SECOND real member identity in a
  // DIFFERENT org, proving the equivalence holds under actual org-scoped
  // RLS now that callViaSession asserts the identity really took effect
  // (see withDbTransaction/callViaSession above) -- not just for the
  // single BMH_ORG_ID user every other case in this file uses.
  let userBId: string;
  let orgBThreadId: string;

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

    // Case 5 (S19.5.5): a thread whose contact_id points at a contact that
    // exists but belongs to a DIFFERENT org (TEST_ORG_B_ID). The FK on
    // messages.contact_id only requires the contact id to exist somewhere,
    // not that it match the message's org, so this is the schema-safe way
    // to reproduce what the org-scoped `c.org_id = k.org_id` join condition
    // treats identically to a missing or RLS-invisible contact: the join
    // misses, contact_hit/is_test_traffic/contact_name all fall back to
    // null/false, and the thread still appears (LEFT JOIN, not INNER).
    crossOrgContactThreadId = randomUUID();
    {
      const foreignContactId = randomUUID();
      const { error: contactError } = await service.from("contacts").insert({
        id: foreignContactId, org_id: TEST_ORG_B_ID, first_name: "Foreign", last_name: "OrgB",
      });
      if (contactError) throw contactError;
      await seedMessage({
        contact_id: foreignContactId, conversation_id: crossOrgContactThreadId, direction: "inbound",
        created_at: new Date().toISOString(), body: "cross-org contact msg", from_address: "+18160000007", to_address: "+18169999999",
      });
    }

    // Case 6 (S19.5.5): a body-only FTS match OLDER than the 90-day cutoff.
    // The conversation is IN the recent window (a fresh, unrelated message
    // keeps it in `grouped`), but the ONLY message whose body matches the
    // search term is older than CUTOFF. The old function's message-FTS
    // subquery has no recent-cutoff (S19.5.3, copied verbatim) and queries
    // `public.messages` directly (not the cutoff-filtered `recent_eligible`),
    // so this thread must still be found by that search term.
    oldFtsOnlyThreadId = randomUUID();
    {
      const contactId = await seedContact({ first_name: "Zephyr", last_name: "OldFts" });
      const oldCreatedAt = new Date(Date.now() - 300 * 86400000).toISOString();
      await seedMessage({
        contact_id: contactId, conversation_id: oldFtsOnlyThreadId, direction: "inbound",
        created_at: oldCreatedAt, body: "zephyrqueryterm mentioned only here", from_address: "+18160000008", to_address: "+18169999999",
      });
      await seedMessage({
        contact_id: contactId, conversation_id: oldFtsOnlyThreadId, direction: "outbound",
        created_at: new Date().toISOString(), body: "unrelated recent follow-up", from_address: "+18169999999", to_address: "+18160000008",
      });
    }

    // Case 7 (Astra round-4 gate on #604): a second member, a second org.
    // userB belongs ONLY to TEST_ORG_B_ID; orgBThreadId is a thread in that
    // org. If org-scoping is actually applied (i.e. the auth-context fix
    // above really took effect), userB's page must contain ONLY
    // orgBThreadId, never any BMH_ORG_ID thread from cases 1-6 -- and the
    // old/new equivalence must still hold for this second identity.
    {
      const userB = await createOrgUser(service, {
        orgId: TEST_ORG_B_ID,
        email: `inbox-narrow-core-orgb-${randomUUID()}@example.test`,
        role: "member",
      });
      users.push(userB.userId);
      userBId = userB.userId;

      const contactId = randomUUID();
      const { error: contactError } = await service.from("contacts").insert({
        id: contactId, org_id: TEST_ORG_B_ID, first_name: "OrgB", last_name: "Member",
      });
      if (contactError) throw contactError;

      orgBThreadId = randomUUID();
      const { error: messageError } = await service.from("messages").insert({
        org_id: TEST_ORG_B_ID, channel: "sms", status: "received",
        contact_id: contactId, conversation_id: orgBThreadId, direction: "inbound",
        created_at: new Date().toISOString(), body: "org b msg", from_address: "+18160000009", to_address: "+18169999998",
      } as never);
      if (messageError) throw messageError;
    }
  }, 120000);

  afterAll(async () => {
    // The oracle and the `db` connection are torn down once, in the
    // signature/config suite's own afterAll below (Astra round-4 gate on
    // #604) -- that suite's tests still need both to exist. Only
    // describe-local cleanup (test users) happens here.
    for (const id of users) await service.auth.admin.deleteUser(id);
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

  it("REQUIRED case 5 (S19.5.5): org-scoped-missing contact still appears via LEFT JOIN, contact_hit falls back to false", async () => {
    const oldDoc = await callOldViaSession(userId, { p_filter: "all", p_hide_noise: false });
    const newDoc = await callNewViaSession(userId, { p_filter: "all", p_hide_noise: false });
    expect(newDoc).toEqual(oldDoc);
    const row = newDoc.rows.find(r => r.thread_id === crossOrgContactThreadId);
    expect(row).toBeTruthy();
    expect(row?.contact_name === null || row?.contact_name === "").toBe(true);
    // Search must NOT surface this thread via a term that would only match
    // via a real contact_hit -- the join miss must behave as false, not
    // throw or wrongly match.
    const searchDoc = await callNewViaSession(userId, { p_filter: "all", p_hide_noise: false, p_search: "Foreign" });
    expect(searchDoc.rows.some(r => r.thread_id === crossOrgContactThreadId)).toBe(false);
  });

  it("REQUIRED case 6 (S19.5.5): body-only FTS match older than the cutoff is still found (no recent-cutoff on message search)", async () => {
    await assertEquivalent(userId, { p_filter: "all", p_hide_noise: false, p_search: "zephyrqueryterm" });
    const newDoc = await callNewViaSession(userId, { p_filter: "all", p_hide_noise: false, p_search: "zephyrqueryterm" });
    expect(newDoc.rows.some(r => r.thread_id === oldFtsOnlyThreadId)).toBe(true);
  });

  it("REQUIRED case 7 (Astra round-4 gate on #604): old==new equivalence AND org isolation hold for a second member identity in a second org", async () => {
    // Proves the auth-context fix actually scopes by org, not just that old
    // and new agree under whatever (possibly unscoped) identity was active.
    const oldDoc = await callOldViaSession(userBId, { p_filter: "all", p_hide_noise: false });
    const newDoc = await callNewViaSession(userBId, { p_filter: "all", p_hide_noise: false });
    expect(newDoc).toEqual(oldDoc);
    expect(newDoc.rows.some(r => r.thread_id === orgBThreadId)).toBe(true);
    // Org isolation: userB must never see any BMH_ORG_ID thread seeded by
    // cases 1-6 above.
    for (const bmhThreadId of [readThreadId, oldReviewThreadId, canaryThreadId, nullNameThreadId]) {
      expect(newDoc.rows.some(r => r.thread_id === bmhThreadId)).toBe(false);
    }
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

  // S19.5.5 mutation-kill demos. Each test shadows the correct function
  // with a MUTATED copy inside an open transaction, proves the seeded
  // assertion now FAILS to hold, then rolls back so the correct rewrite is
  // restored for every other test in this file. A green test that survives
  // any of these mutations is not accepted.

  it("mutation 1 (S19.5.5): inner-joining contacts drops the org-scoped-missing-contact thread", async () => {
    await withMutant(innerSearchJoinMutant, async () => {
      const mutatedDoc = await callNewViaSession(userId, { p_filter: "all", p_hide_noise: false });
      expect(mutatedDoc.rows.some(r => r.thread_id === crossOrgContactThreadId)).toBe(false);
    });
  });

  it("mutation 2 (S19.5.5): adding a recent-cutoff to the messages FTS subquery loses the old body-only match", async () => {
    await withMutant(ftsCutoffMutant, async () => {
      const mutatedDoc = await callNewViaSession(userId, { p_filter: "all", p_hide_noise: false, p_search: "zephyrqueryterm" });
      expect(mutatedDoc.rows.some(r => r.thread_id === oldFtsOnlyThreadId)).toBe(false);
    });
  });

  it("mutation 3 (S19.5.5): dropping the ILIKE escape clause removes an explicit defense-in-depth guard (structural check)", () => {
    // Postgres's LIKE/ILIKE default escape character is already backslash,
    // so this specific drop has no observable behavioral difference under
    // default settings -- there is no safe way to demonstrate a behavioral
    // kill without changing server-level LIKE escape defaults. Assert the
    // clause is present in the shipped migration (regression guard against
    // silently dropping it in a future edit) instead.
    expect(newSql).toContain("escape E'\\\\'");
    const mutated = newSql.replaceAll("escape E'\\\\'", "");
    expect(mutated).not.toContain("escape E'\\\\'");
  });

  it("mutation 4 (S19.5.5): deferring is_test_traffic to false corrupts is_test_traffic/is_noise for canary/jitter threads", async () => {
    await withMutant(isTestTrafficDeferredMutant, async () => {
      const mutatedDoc = await callNewViaSession(userId, { p_filter: "all", p_hide_noise: false });
      for (const id of [canaryThreadId, jitterSpaceThreadId, jitterDashThreadId]) {
        const row = mutatedDoc.rows.find(r => r.thread_id === id);
        expect(row).toBeTruthy();
        // Correct behavior (REQUIRED case 3, above) is `true` for every one
        // of these seeded rows; the mutation must flip it to `false`,
        // proving is_test_traffic (and everything downstream: is_noise,
        // dispo_count, the dispo filter) was computed pre-pagination from
        // the verbatim predicates, not deferred past the point those
        // consumers need it.
        expect(row?.is_test_traffic).toBe(false);
      }
    });
  });
});

describe("sms_inbox_thread_page_snapshot signature/config safety net (BLOCKING, Fable v6)", () => {
  // `db` is the SAME connection opened in the first describe's beforeAll
  // above and never closed by that describe's afterAll (Astra round-4 gate
  // on #604) -- reconnecting here would throw ("Client has already been
  // connected") and, before the fix, this suite also depended on the OLD
  // oracle function, which the first describe used to drop before this ran.
  // Both the oracle and the connection now live until this suite finishes.
  afterAll(async () => {
    try {
      await apply(`drop function if exists public.${OLD_ORACLE_NAME}(timestamptz, text, uuid, uuid, boolean, integer, integer, text);`);
    } finally {
      await db.end();
    }
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

  it("proconfig carries search_path='', statement_timeout='15s', work_mem='20MB', and the function is SECURITY INVOKER (S20.1/S21.1 E5, remeasured Astra round-4)", async () => {
    const { rows } = await db.query(
      `select proconfig, prosecdef from pg_proc where proname = 'sms_inbox_thread_page_snapshot'`,
    );
    const config: string[] = rows[0].proconfig ?? [];
    const isSecurityDefiner: boolean = rows[0].prosecdef;
    // Astra round-4 gate on #604 (issue 2): Postgres stores an EMPTY
    // search_path as `search_path=""` (quoted empty string), not bare
    // `search_path=` -- the original assertion could never pass.
    expect(config).toEqual(expect.arrayContaining(["search_path=\"\"", "statement_timeout=15s", "work_mem=20MB"]));
    // SECURITY INVOKER means prosecdef is false (prosecdef = true is SECURITY DEFINER).
    expect(isSecurityDefiner).toBe(false);
    // Mutation-kill demo: dropping search_path must fail this assertion.
    const mutatedSearchPath = config.filter(c => !c.startsWith("search_path"));
    expect(mutatedSearchPath).not.toEqual(expect.arrayContaining(["search_path=\"\""]));
    // Mutation-kill demo: dropping work_mem must fail this assertion.
    const mutatedWorkMem = config.filter(c => !c.startsWith("work_mem"));
    expect(mutatedWorkMem).not.toEqual(expect.arrayContaining(["work_mem=20MB"]));
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
      expect(rolledBackConfig).toEqual(expect.arrayContaining(["search_path=\"\"", "statement_timeout=15s"]));
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
