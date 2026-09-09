import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, TEST_ORG_B_ID, clientForUser, createOrgUser, seedTwoOrgs } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

const service = createTestClient();
const sql = readFileSync(new URL("./20260909000000_global_search.sql", import.meta.url), "utf8");
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const users: string[] = [];
let a: ReturnType<typeof clientForUser>;
let b: ReturnType<typeof clientForUser>;
let live: string;
let owner: string;
let orphan: string;
let threadOnly: string;
const conversation = randomUUID();

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
      await db.query(process.env.SEARCH_MUTATE_PHONE === "1"
        ? sql.replace("or (length(i.qd) >= 3 and c.phone_digits ilike '%' || i.qd || '%')", "or false /* mutation: phone branch removed */")
        : sql);
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
      { org_id: BMH_ORG_ID, contact_id: threadOnly, conversation_id: conversation, channel: "sms", direction: "inbound", body: "Appointment foo@example.com costs 45.5 dollars", from_address: "+18165551234", to_address: "+18165559999", created_at: "2026-09-01T12:00:00Z" },
      { org_id: BMH_ORG_ID, contact_id: threadOnly, conversation_id: conversation, channel: "sms", direction: "inbound", body: "Appointment reminder", from_address: "+18165551234", to_address: "+18165559999", created_at: "2026-09-02T12:00:00Z" },
      { org_id: BMH_ORG_ID, contact_id: owner, conversation_id: randomUUID(), channel: "email", direction: "inbound", body: "Appointment email only", created_at: "2026-09-02T12:00:00Z", from_address: "a@example.test", to_address: "b@example.test" },
    ]);
    if (error) throw new Error(error.message);
    await property(null, "100 Literal%Place");
    for (let i = 0; i < 12; i++) await property(null, `${i} Clampville Avenue`);
  }, 60000);

  afterAll(async () => {
    try {
      if (process.env.SEARCH_MUTATE_PHONE === "1") {
        await db.query("begin");
        try { await db.query(sql); await db.query("commit"); }
        catch (error) { await db.query("rollback"); throw error; }
      }
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
  it.each(["appoin", "example.com", "45.5"])("finds normalized SMS prefix %s", async (q) => {
    const threads = (await search(q)).filter(r => r.entity_type === "thread");
    expect(threads).toHaveLength(1);
    expect(threads[0].conversation_id).toBe(conversation);
    if (q === "appoin") expect(threads[0].subtitle).toBe("Appointment reminder");
  });
  it("keeps live destinations, uses a thread for deleted-only owners, and excludes orphans before limiting", async () => {
    const rows = await search("Zephyrson", a, 10);
    expect(rows.find(r => r.entity_id === owner)?.property_id).toBe(live);
    expect(rows.find(r => r.entity_id === threadOnly)).toMatchObject({ property_id: null, conversation_id: conversation });
    expect(rows.some(r => r.entity_id === orphan)).toBe(false);
    expect((await search("Sunflower", a, 10)).filter(r => r.entity_type === "property")).toHaveLength(1);
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
  it("normalizes punctuation and truncates the query to six original-order tokens", async () => {
    const { rows } = await db.query("select public.search_prefix_tsquery('!!!') is null as empty, public.search_prefix_tsquery('one two three four five six seven')::text as tokens");
    expect(rows[0].empty).toBe(true);
    expect(rows[0].tokens).toBe("'one':* & 'two':* & 'three':* & 'four':* & 'five':* & 'six':*");
  });
  it.skipIf(process.env.SEARCH_MEASURE !== "1")("records authenticated branch plans and whole-RPC p95", async () => {
    const body = sql.split("as $$\n  with bounds as (")[1].split("\n$$;")[0];
    const ctes = "with bounds as (" + body.split("  select * from property_hits")[0];
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: users[0], role: "authenticated" })]);
      for (const q of ["Sun", "901 Sunf", "(816) 555", "Ada@exam", "foo@example.com!!!"]) {
        for (const branch of ["property_hits", "owner_hits", "thread_hits"]) {
          const plan = await db.query("explain (analyze, buffers, format json) " + ctes + "select * from " + branch, [q, 5]);
          console.log("SEARCH_EXPLAIN", JSON.stringify({ q, branch, plan: plan.rows[0]["QUERY PLAN"] }));
        }
        const times: number[] = [];
        for (let i = 0; i < 20; i++) {
          const start = performance.now(); await search(q); times.push(performance.now() - start);
        }
        times.sort((x, y) => x - y);
        console.log("SEARCH_P95", JSON.stringify({ q, runs: 20, p95Ms: times[18], maxMs: times[19] }));
        expect(times[18]).toBeLessThan(300);
      }
    } finally { await db.query("rollback"); }
  }, 120000);

});
