import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, TEST_ORG_B_ID, clientForUser, createOrgUser, seedTwoOrgs } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

const service = createTestClient();
const sql = readFileSync(new URL("./20260909080000_messages_search.sql", import.meta.url), "utf8");
const originalGlobalSql = readFileSync(new URL("./20260909000000_global_search.sql", import.meta.url), "utf8");
const fixSql = readFileSync(new URL("./20260909080600_search_relevance_fixes.sql", import.meta.url), "utf8");
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const users: string[] = [];
let a: ReturnType<typeof clientForUser>;
let b: ReturnType<typeof clientForUser>;
const threads = Array.from({ length: 5 }, () => randomUUID());
type Page = { rows: { thread_id: string; last_message_body: string }[]; total: number; counts: { all: number }; offset: number };
async function apply(source: string) {
  await db.query("begin");
  try { await db.query(source); await db.query("commit"); }
  catch (error) { await db.query("rollback"); throw error; }
}
async function page(search?: string | null, offset = 0, client = a) {
  const { data, error } = await client.rpc("sms_inbox_thread_page_snapshot", {
    p_cutoff: new Date(Date.now() - 86400000).toISOString(), p_filter: "all",
    p_hide_noise: false, p_limit: 2, p_offset: offset,
    ...(search === undefined ? {} : { p_search: search }),
  });
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data as unknown as Page;
}

describe("Messages page search RPC", () => {
  beforeAll(async () => {
    await db.connect();
    // The integration global setup holds the shared session advisory mutex.
    const source = process.env.MESSAGES_SEARCH_MUTATION === "1"
      ? sql.replace("where (\n      search.q is null", "where (\n      false and search.q is null")
        .replace("or c.search_text ilike", "or false and c.search_text ilike")
        .replace("or (length(search.digits)", "or false and (length(search.digits)")
        .replace("or exists (\n        select 1 from public.messages matching_message", "or false and exists (\n        select 1 from public.messages matching_message")
      : sql;
    await apply(originalGlobalSql + source + fixSql);
    await apply(originalGlobalSql + source + fixSql);
    if (process.env.SEARCH_MUTATION === "weak-prefix") {
      await apply(fixSql.replace("bool_or(length(token) >= 3)", "true"));
    }
    await resetTenantTables(service);
    await seedTwoOrgs(service);
    for (const [orgId, assign] of [[BMH_ORG_ID, (c: typeof a) => { a = c; }], [TEST_ORG_B_ID, (c: typeof a) => { b = c; }]] as const) {
      const user = await createOrgUser(service, { orgId, email: `messages-search-${randomUUID()}@example.test`, role: "member" });
      users.push(user.userId); assign(clientForUser(user.jwt));
    }
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      const { error: contactError } = await service.from("contacts").insert({ id, org_id: BMH_ORG_ID,
        first_name: `Ada${i}`, last_name: i === 0 ? "Zephyrson" : "Other",
        phone_1: i === 0 ? "(816) 555-1234" : null, phone_1_type: i === 0 ? "mobile" : "unknown" });
      if (contactError) throw contactError;
      const { error } = await service.from("messages").insert({ org_id: BMH_ORG_ID, contact_id: id,
        conversation_id: threads[i], channel: "sms", direction: "inbound", status: "received",
        body: i === 0 ? "Name only matches" : i < 4 ? "Zephyrson appointment foo@example.com" : "Unrelated message alpha beta 45.5 dollars 45.50 total 811 total 8111 N Stoddard",
        from_address: "+18165551234", to_address: "+18165559999", created_at: new Date(Date.now() - i * 1000).toISOString() });
      if (error) throw error;
    }
  }, 60000);
  afterAll(async () => {
    try {
      if (process.env.MESSAGES_SEARCH_MUTATION || process.env.SEARCH_MUTATION) await apply(originalGlobalSql + sql + fixSql);
      for (const id of users) await service.auth.admin.deleteUser(id);
    } finally { await db.end(); }
  });

  it("searches surname OR message body before totals and pagination", async () => {
    const first = await page("Zephyrson");
    const second = await page("Zephyrson", 2);
    expect(first.total).toBe(4); expect(first.counts.all).toBe(4);
    expect(second.total).toBe(4); expect(second.offset).toBe(2);
    expect(first.rows).toHaveLength(2); expect(second.rows).toHaveLength(2);
    expect(new Set([...first.rows, ...second.rows].map(r => r.thread_id))).toEqual(new Set(threads.slice(0, 4)));
  });
  it.each(["816555", "(816) 555", "816-555"])("searches formatted phone %s", async (query) => {
    const result = await page(query); expect(result.total).toBe(1);
    expect(result.rows[0].thread_id).toBe(threads[0]);
  });
  it.each(["appoin", "example.com"])("searches normalized SMS prefix %s", async (query) => {
    expect((await page(query)).total).toBe(3);
  });
  it.each(["a\\b", "45.5"])("rejects weak body-only RPC query %s", async q => {
    expect((await page(q)).total).toBe(0);
  });
  it.each(["45.50 total", "811 total", "8111 N Stoddard"])("finds strong body-only query %s", async q => {
    const result = await page(q);
    expect(result.total).toBe(1);
    expect(result.rows.map(r => r.thread_id)).toEqual([threads[4]]);
  });
  it("accepts authenticated calls with omitted, null, and short search", async () => {
    for (const search of [undefined, null, "ab", "  a  "]) expect((await page(search)).total).toBe(5);
  });
  it("does not expose another organization's name or body matches", async () => {
    expect((await page("Zephyrson", 0, b)).total).toBe(0);
  });
  it("keeps punctuation literal and returns no unrelated matches", async () => {
    expect((await page("%%%" )).total).toBe(0);
    expect((await page("missingneedle")).total).toBe(0);
  });
  it("denies anonymous execution", async () => {
    const anon = createClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    const { error } = await anon.rpc("sms_inbox_thread_page_snapshot", { p_cutoff: new Date().toISOString(), p_search: "Zephyrson" });
    expect(error).not.toBeNull();
    expect(error?.code).toMatch(/42501|PGRST202/);
  });
  it("has one eight-argument invoker signature, pinned search path, timeout, and exact grants after two applications", async () => {
    const { rows } = await db.query(`select pronargs, provolatile, prosecdef, proconfig,
      has_function_privilege('anon', p.oid, 'execute') as anon,
      has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
      has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='sms_inbox_thread_page_snapshot'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pronargs: 8, provolatile: "s", prosecdef: false, anon: false, authenticated: true, service: true });
    expect(rows[0].proconfig).toContain('search_path=""');
    expect(rows[0].proconfig).toContain("statement_timeout=15s");
  });
});
