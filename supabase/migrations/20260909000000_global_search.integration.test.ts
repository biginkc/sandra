import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, TEST_ORG_B_ID, clientForUser, createOrgUser, seedTwoOrgs } from "@tests/integration/fixtures/multi-user";
import { registerDefinerPerformance } from "@tests/integration/search-definer-performance";
import { registerDefinerTests } from "@tests/integration/search-definer";
import { resetTenantTables } from "@tests/integration/reset";

const service = createTestClient();
const originalSql = readFileSync(new URL("./20260909000000_global_search.sql", import.meta.url), "utf8");
const relevanceSql = readFileSync(new URL("./20260909080600_search_relevance_fixes.sql", import.meta.url), "utf8");
const definerSql = readFileSync(new URL("./20260909084500_search_global_definer_scoping.sql", import.meta.url), "utf8");
const sql = relevanceSql + definerSql;
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const users: string[] = [];
let a: ReturnType<typeof clientForUser>;
let b: ReturnType<typeof clientForUser>;
let live: string;
let owner: string;
let orphan: string;
let threadOnly: string;
const conversation = randomUUID();
const capOwners = Array.from({ length: 12 }, () => randomUUID()).sort();
const capMessages = Array.from({ length: 12 }, () => randomUUID()).sort();
const tieMessages = [randomUUID(), randomUUID()].sort();
const tieConversation = randomUUID();
let reachable: string;
let originalPrivileges: { proname: string; proacl: string[] | null }[];

// Deliberately broken SQL is opt-in; teardown always restores the source SQL.
function mutationSql(sql: string) {
  switch (process.env.SEARCH_MUTATION) {
    case "structured-gate": return sql.replaceAll("not i.is_structured and ", "");
    case "email-equality": return sql.replace("c.search_text ilike '%' || i.q_like || '%'", "lower(c.email) like i.q_like");
    case "no-similarity": return sql.replaceAll("not i.is_structured and ", "false and ");
    case "weak-prefix": return sql.replace("bool_or(length(token) >= 3)", "true");
    case "drop-short": return sql.replace("where token <> ''", "where length(token) >= 3");
    case "boundary": return sql.replace("10 * length(qd) >= 7 * length(q)", "10 * length(qd) > 7 * length(q)");
    case "orphan": return sql.replace("from contact_candidates c", `from (select * from contact_candidates
      order by extensions.similarity(search_text,lower(q)) desc, created_at desc, id desc
      limit (select per_type from bounds)) c`);
    case "owner-tie": return sql.replace("c.created_at desc, c.id desc", "c.created_at desc, c.id asc");
    case "message-tie": return sql.replace("m.conversation_id, m.created_at desc, m.id desc", "m.conversation_id, m.created_at desc, m.id asc");
    case "thread-tie": return sql.replace("m.rank desc, m.created_at desc, m.id desc", "m.rank desc, m.created_at desc, m.id asc");
    case "owner-cap": return sql.replace("limit (select per_type from bounds)\n  ), matching_messages", "limit 999\n  ), matching_messages");
    case "thread-cap": return sql.replace("limit (select per_type from bounds)\n  )\n  select", "limit 999\n  )\n  select");
    default: return sql;
  }
}

async function property(contact: string | null, address: string, deleted = false) {
  const { data, error } = await service.from("properties").insert({
    org_id: BMH_ORG_ID, address, city: "Dayton", state: "OH", zip: address === "901 Sunflower Avenue" ? "45402" : "45403",
    homeowner_contact_id: contact, deleted_at: deleted ? new Date().toISOString() : null,
  }).select("id").single();
  if (error || !data) throw new Error(error?.message ?? "property seed failed");
  return data.id;
}
async function contact(first: string) {
  const { data, error } = await service.from("contacts").insert({
    org_id: BMH_ORG_ID, first_name: first, last_name: "Zephyrson", entity_name: "Orchid Holdings",
    email: `${first}@example.com`, phone_1: first === "Ada" ? "(816) 555-1234" : null, phone_3: first === "Ada" ? "+1 (937) 888-4321" : null, phone_1_type: first === "Ada" ? "mobile" : "unknown", phone_3_type: first === "Ada" ? "mobile" : "unknown",
  }).select("id").single();
  if (error || !data) throw new Error(error?.message ?? "contact seed failed");
  return data.id;
}
async function search(q: string, client = a, per_type = 5) {
  const { data, error } = await client.rpc("search_global", { q, per_type });
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data ?? [];
}

describe("global search RPC", () => {
  beforeAll(async () => {
    await db.connect();
    // The integration global setup holds the shared session advisory mutex.
    await db.query("begin");
    try {
      await db.query(originalSql);
      originalPrivileges = (await db.query(`select proname, proacl from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and proname in ('search_global','search_prefix_tsquery') order by proname`)).rows;
      await db.query(sql);
      await db.query(sql);
      const installed = (await db.query("select pg_get_functiondef('public.search_global(text,integer)'::regprocedure) as body")).rows[0].body;
      const helper = (await db.query("select pg_get_functiondef('public.search_prefix_tsquery(text)'::regprocedure) as body")).rows[0].body;
      const finalDefinition = helper + ";\n" + installed;
      const mutated = process.env.SEARCH_MUTATE_PHONE === "1"
        ? finalDefinition.replace("or (length(i.qd) >= 3 and c.phone_digits ilike '%' || i.qd || '%')", "or false /* mutation: phone branch removed */")
        : mutationSql(finalDefinition);
      if (process.env.SEARCH_MUTATION || process.env.SEARCH_MUTATE_PHONE === "1") expect(mutated).not.toBe(finalDefinition);
      await db.query(mutated);
      await db.query("commit");
    } catch (error) { await db.query("rollback"); throw error; }
    await resetTenantTables(service);
    await seedTwoOrgs(service);
    const userA = await createOrgUser(service, { orgId: BMH_ORG_ID, email: `global-a-${randomUUID()}@example.test`, role: "member" });
    users.push(userA.userId); a = clientForUser(userA.jwt);
    const userB = await createOrgUser(service, { orgId: TEST_ORG_B_ID, email: `global-b-${randomUUID()}@example.test`, role: "member" });
    users.push(userB.userId); b = clientForUser(userB.jwt);
    owner = await contact("Ada");
    live = await property(owner, "901 Sunflower Avenue");
    await property(owner, "902 Deleted Sunflower Avenue", true);
    orphan = await contact("Orphan");
    threadOnly = await contact("Threadonly");
    await property(threadOnly, "903 Deleted Sunflower Avenue", true);
    const { error } = await service.from("messages").insert([
      { org_id: BMH_ORG_ID, contact_id: threadOnly, conversation_id: conversation, channel: "sms", direction: "inbound", body: "Appointment foo@example.com costs 45.5 dollars 45.50 total alpha beta 811 total 8111 N Stoddard", from_address: "+18165551234", to_address: "+18165559999", created_at: "2026-09-01T12:00:00Z" },
      { org_id: BMH_ORG_ID, contact_id: threadOnly, conversation_id: conversation, channel: "sms", direction: "inbound", body: "Appointment reminder", from_address: "+18165551234", to_address: "+18165559999", created_at: "2026-09-02T12:00:00Z" },
      { org_id: BMH_ORG_ID, contact_id: owner, conversation_id: randomUUID(), channel: "email", direction: "inbound", body: "Appointment email only", created_at: "2026-09-02T12:00:00Z", from_address: "a@example.test", to_address: "b@example.test" },
    ]);
    if (error) throw new Error(error.message);
    await property(null, "100 Literal%Place");
    for (let i = 0; i < 12; i++) await property(null, `${i} Clampville Avenue`);
    // Exact-match orphans outrank the reachable contact and exhaust a limit of two.
    for (let i = 0; i < 4; i++) {
      await db.query(`insert into contacts (org_id, first_name, phone_1_type)
        values ($1, 'Orphanguard', 'unknown')`, [BMH_ORG_ID]);
    }
    reachable = await contact("Orphanguard reachable with deliberately longer text");
    await property(reachable, "810 Reachable Lane");
    for (let i = 0; i < 12; i++) {
      await db.query(`insert into contacts (id, org_id, first_name, phone_1_type, created_at)
        values ($1,$2,'Capowner','unknown','2026-09-01T12:00:00Z')`, [capOwners[i], BMH_ORG_ID]);
      await property(capOwners[i], `${i} Reachable Cap Lane`);
      await db.query(`insert into messages (id,org_id,contact_id,conversation_id,channel,direction,body,from_address,to_address,created_at)
        values ($1,$2,$3,$4,'sms','inbound','Capthread','+18165551234','+18165559999','2026-09-01T12:00:00Z')`,
        [capMessages[i], BMH_ORG_ID, capOwners[i], randomUUID()]);
    }
    for (const id of tieMessages) {
      await db.query(`insert into messages (id,org_id,contact_id,conversation_id,channel,direction,body,from_address,to_address,created_at)
        values ($1,$2,$3,$4,'sms','inbound','Tiemessage','+18165551234','+18165559999','2026-09-01T12:00:00Z')`,
        [id, BMH_ORG_ID, owner, tieConversation]);
    }
  }, 60000);

  afterAll(async () => {
    try {
      await db.query("begin");
      try { await db.query(originalSql); await db.query(sql); await db.query("commit"); }
      catch (error) { await db.query("rollback"); throw error; }
      for (const id of users) await service.auth.admin.deleteUser(id);
    } finally { await db.end(); }
  });

  it.each(["901 Sunflower", "45402"])("finds property by %s", async (q) => {
    expect((await search(q)).filter(r => r.entity_type === "property").map(r => r.entity_id)).toContain(live);
  });
  it.each(["Zephyrson", "Orchid Holdings", "Ada@example.com"])("finds owner by %s", async (q) => {
    expect((await search(q)).filter(r => r.entity_type === "owner").map(r => r.entity_id)).toContain(owner);
  });
  it.each(["816555", "(816) 555", "816-555", "937888"])("finds formatted phone and slot 3 by %s", async (q) => {
    expect((await search(q)).filter(r => r.entity_type === "owner" && r.matched_field === "phone").map(r => r.entity_id)).toContain(owner);
  });
  it.each(["appoin", "example.com", "45.50 total", "811 total", "8111 N Stoddard"])("finds normalized SMS prefix %s", async (q) => {
    const threads = (await search(q)).filter(r => r.entity_type === "thread");
    expect(threads).toHaveLength(1);
    expect(threads[0].conversation_id).toBe(conversation);
    if (q === "appoin") expect(threads[0].subtitle).toBe("Appointment reminder");
  });
  it.each(["a\\b", "45.5"])("rejects weak body-only RPC query %s", async q => {
    expect((await search(q)).filter(r => r.entity_type === "thread")).toEqual([]);
  });
  it.each([
    ["a\\b", null], ["ab", null], ["1.2", null], ["45.5", null],
    ["appoin", "'appoin':*"], ["8111 N Stoddard", "'8111':* & 'n':* & 'stoddard':*"],
    ["foo@example.com", "'foo':* & 'example':* & 'com':*"], ["100%%", "'100':*"],
    ["a b c d e f seventh", null],
    ["one b c d e f seventh", "'one':* & 'b':* & 'c':* & 'd':* & 'e':* & 'f':*"],
  ])("normalizes selected tokens for %s", async (q, expected) => {
    const { rows } = await db.query("select public.search_prefix_tsquery($1)::text as query", [q]);
    expect(rows[0].query).toBe(expected);
  });
  it("gates similar emails while preserving partial-email substrings", async () => {
    const id = await contact("Emailfixture");
    await db.query("update contacts set first_name=null,last_name=null,entity_name=null,email='bhaggard91@gmail.com' where id=$1", [id]);
    await property(id, "Reachable Email Lane");
    const { rows } = await db.query("select search_text OPERATOR(extensions.%) 'bhaggard90@gmail.com' as fuzzy, search_text like '%bhaggard90@gmail.com%' as substring from contacts where id=$1", [id]);
    expect(rows[0]).toEqual({ fuzzy: true, substring: false });
    expect((await search("bhaggard90@gmail.com")).filter(r => r.entity_type === "owner")).toEqual([]);
    expect((await search("bhaggard91@gma")).filter(r => r.entity_type === "owner").map(r => r.entity_id)).toEqual([id]);
  });
  it("keeps misspelled surnames fuzzy eligible", async () => {
    const id = await contact("Surnamefixture");
    await db.query("update contacts set first_name=null,last_name='Vanderplanken',entity_name=null,email=null where id=$1", [id]);
    await property(id, "Reachable Surname Lane");
    const { rows } = await db.query("select search_text OPERATOR(extensions.%) 'vanderplankin' as fuzzy, search_text like '%vanderplankin%' as substring from contacts where id=$1", [id]);
    expect(rows[0]).toEqual({ fuzzy: true, substring: false });
    expect((await search("Vanderplankin")).filter(r => r.entity_type === "owner").map(r => r.entity_id)).toEqual([id]);
  });
  it.each([
    ["bhaggard91@gmail.com", "bhaggard90@gmail.com", false],
    ["1234568abc", "1234567abc", false], // exactly 70% digits
    ["123457abcd", "123456abcd", true], // 60% digits
    ["8111 N Stoddard", "8111 N Stodard", true],
  ])("gates property similarity for %s / %s", async (address, q, expected) => {
    const id = await property(null, address);
    await db.query("update properties set city='',state='',zip='',market=null,apn=null,mls_number=null where id=$1", [id]);
    const { rows } = await db.query("select search_text OPERATOR(extensions.%) lower($2) as fuzzy, search_text like '%' || lower($2) || '%' as substring from properties where id=$1", [id, q]);
    expect(rows[0]).toEqual({ fuzzy: true, substring: false });
    const ids = (await search(q, a, 10)).filter(r => r.entity_type === "property").map(r => r.entity_id);
    if (expected) expect(ids).toContain(id);
    else expect(ids).toEqual([]);
  });
  it("keeps live destinations, uses a thread for deleted-only owners, and excludes orphans before limiting", async () => {
    const rows = await search("Zephyrson", a, 10);
    expect(rows.find(r => r.entity_id === owner)?.property_id).toBe(live);
    expect(rows.find(r => r.entity_id === threadOnly)).toMatchObject({ property_id: null, conversation_id: conversation });
    expect(rows.some(r => r.entity_id === orphan)).toBe(false);
    expect((await search("Sunflower", a, 10)).filter(r => r.entity_type === "property")).toHaveLength(1);
  });
  it("filters higher-ranked orphans before the owner limit", async () => {
    const { rows } = await db.query(`select id from contacts where first_name like 'Orphanguard%'
      order by extensions.similarity(search_text,'orphanguard') desc, created_at desc, id desc limit 2`);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.id)).not.toContain(reachable);
    expect((await search("Orphanguard", a, 2)).filter(r => r.entity_type === "owner").map(r => r.entity_id)).toEqual([reachable]);
  });
  it("breaks equal-rank equal-timestamp owner ties by descending ID", async () => {
    expect((await search("Capowner", a, 5)).filter(r => r.entity_type === "owner").map(r => r.entity_id))
      .toEqual([...capOwners].reverse().slice(0, 5));
  });
  it("breaks equal-timestamp messages within a conversation by descending ID", async () => {
    expect((await search("Tiemessage")).filter(r => r.entity_type === "thread").map(r => r.entity_id)).toEqual([tieMessages[1]]);
  });
  it("breaks equal-rank equal-timestamp thread ties by descending ID", async () => {
    expect((await search("Capthread", a, 5)).filter(r => r.entity_type === "thread").map(r => r.entity_id))
      .toEqual([...capMessages].reverse().slice(0, 5));
  });
  it("caps more than ten reachable owners", async () => {
    expect((await search("Capowner", a, 999)).filter(r => r.entity_type === "owner")).toHaveLength(10);
  });
  it("caps more than ten distinct reachable threads", async () => {
    expect((await search("Capthread", a, 999)).filter(r => r.entity_type === "thread")).toHaveLength(10);
  });
  it.each(["Sunflower", "Zephyrson", "816555", "appoin"])("org B cannot see org A results for %s", async q => {
    expect(await search(q, b)).toEqual([]);
  });
  it("guards short input, clamps per-type limits, and treats percent literally", async () => {
    expect(await search("ab")).toEqual([]);
    expect(await search("   ")).toEqual([]);
    expect((await search("Clampville", a, 999)).filter(r => r.entity_type === "property")).toHaveLength(10);
    expect((await search("Clampville", a, 0)).filter(r => r.entity_type === "property")).toHaveLength(1);
    const rows = await search("%%%", a, 10);
    expect(rows).toEqual([]);
    expect((await search("Literal%Place")).some(r => r.title === "100 Literal%Place")).toBe(true);
  });
  it("preserves helper and RPC signatures, volatility, definer rights, search path and grants", async () => {
    const { rows } = await db.query(`select proname, pronargs, provolatile, prosecdef, proconfig,
      has_function_privilege('anon', p.oid, 'execute') as anon,
      has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
      has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('search_global','search_prefix_tsquery') order by proname`);
    const privileges = await db.query(`select proname, proacl from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and proname in ('search_global','search_prefix_tsquery') order by proname`);
    expect(privileges.rows[1]).toEqual(originalPrivileges[1]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ proname: "search_global", pronargs: 2, provolatile: "s", prosecdef: true, anon: false, authenticated: true, service: true });
    expect(rows[1]).toMatchObject({ proname: "search_prefix_tsquery", pronargs: 1, provolatile: "i", prosecdef: false });
    for (const row of rows) expect(row.proconfig).toContain("search_path=public, pg_temp");
  });
  it("normalizes punctuation and truncates the query to six original-order tokens", async () => {
    const { rows } = await db.query("select public.search_prefix_tsquery('!!!') is null as empty, public.search_prefix_tsquery('one two three four five six seven')::text as tokens");
    expect(rows[0].empty).toBe(true);
    expect(rows[0].tokens).toBe("'one':* & 'two':* & 'three':* & 'four':* & 'five':* & 'six':*");
  });
  registerDefinerTests(db, service, () => ({ a, b, userId: users[0], owner, live, conversation }));

  registerDefinerPerformance(db, service);

});
