import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

// Calls public.search_properties directly through authenticated user clients.
// The suite replays the migration SQL under the integration advisory mutex
// (same pattern as 20260909000000_global_search.integration.test.ts). Setting
// SEARCH_PROPS_MUTATION installs a deliberately broken copy instead; teardown
// always restores the real SQL. Each mutation must make >=1 test fail.

const service = createTestClient();
const migrationSql = readFileSync(new URL("./20261002110100_search_properties.sql", import.meta.url), "utf8");
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });

export function mutate(sql: string, name: string | undefined): string {
  switch (name) {
    case "drop-org-gate": return sql.replace(/\b\w+\.org_id in \(select org_id from visible_orgs\)/g, "true");
    case "drop-agent-join": return sql.replace("(p.homeowner_contact_id = c.id or p.agent_contact_id = c.id)", "p.homeowner_contact_id = c.id");
    case "drop-deleted-at": return sql.replace(/\s+and p\.deleted_at is null/g, "");
    case "drop-like-escape": return sql.replace("replace(replace(replace(lower(bounds.q), E'\\\\', E'\\\\\\\\'), '%', E'\\\\%'), '_', E'\\\\_') as q_like", "lower(bounds.q) as q_like");
    case "add-limit-100": return sql.replace("and p.deleted_at is null;\n  $search$", "and p.deleted_at is null limit 100;\n  $search$");
    case "drop-sms-channel": return sql.replace("m.channel = 'sms'", "true");
    case "drop-length-cap": return sql.replace("rtrim(left(btrim(regexp_replace(coalesce($1,''), '\\s+', ' ', 'g')),100))", "btrim(regexp_replace(coalesce($1,''), '\\s+', ' ', 'g'))");
    case "drop-structured": return sql.replace("(i.is_structured and length(i.qd) >= 3", "(length(i.qd) >= 3");
    case "auth-uid-null": return sql.replaceAll("auth.uid()", "null::uuid");
    default: return sql;
  }
}

const tag = randomUUID().slice(0, 6);
const users: string[] = [];
let a: ReturnType<typeof clientForUser>;
let a2: ReturnType<typeof clientForUser>; // second member, acquisitions-restricted
let b: ReturnType<typeof clientForUser>;
let userA = "";
let userA2 = "";
let userB = "";
let anon: SupabaseClient<Database>;

type Ids = Record<string, string>;
const P: Ids = {};

async function contact(org: string, v: Record<string, unknown>) {
  const { data, error } = await service.from("contacts").insert({
    org_id: org, phone_1_type: v.phone_1 ? "mobile" : "unknown", phone_2_type: v.phone_2 ? "mobile" : "unknown", phone_3_type: v.phone_3 ? "mobile" : "unknown", ...v,
  }).select("id").single();
  if (error || !data) throw new Error(error?.message ?? "contact seed failed");
  return data.id as string;
}
async function property(org: string, v: Record<string, unknown>) {
  const { data, error } = await service.from("properties").insert({ org_id: org, city: "Springfield", state: "MO", zip: "65801", ...v } as Database["public"]["Tables"]["properties"]["Insert"]).select("id").single();
  if (error || !data) throw new Error(error?.message ?? "property seed failed");
  return data.id as string;
}
async function sms(org: string, propertyId: string | null, contactId: string | null, body: string, channel = "sms", conversation: string | null = randomUUID()) {
  const { error } = await service.from("messages").insert({
    org_id: org, property_id: propertyId, contact_id: contactId, conversation_id: conversation, channel,
    direction: "inbound", body, from_address: "+15550000001", to_address: "+15550000002",
  });
  if (error) throw new Error(error.message);
}
async function ids(q: string, client = a, include = true): Promise<string[]> {
  const { data, error } = await client.rpc("search_properties", { q, include_messages: include }).select("id");
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return (data ?? []).map((r: { id: string }) => r.id).sort();
}
const sorted = (...v: string[]) => [...v].sort();

describe("search_properties RPC", () => {
  beforeAll(async () => {
    // Destructive setup (resets, user deletes, migration replay): local stack only.
    assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
    await db.connect();
    await db.query("begin");
    try {
      await db.query(mutate(migrationSql, process.env.SEARCH_PROPS_MUTATION));
      await db.query("commit");
    } catch (error) { await db.query("rollback"); throw error; }
    if (process.env.SEARCH_PROPS_MUTATION) {
      expect(mutate(migrationSql, process.env.SEARCH_PROPS_MUTATION)).not.toBe(migrationSql);
    }
    await resetTenantTables(service);
    await seedTwoOrgs(service);
    const mk = async (org: string, email: string) => {
      const u = await createOrgUser(service, { orgId: org, email: `sp-${tag}-${email}-${randomUUID()}@example.test`, role: "member" });
      users.push(u.userId);
      return u;
    };
    // A fresh database has no org owner; the final-owner guard needs one before members.
    for (const org of [BMH_ORG_ID, TEST_ORG_B_ID]) {
      const owner = await createOrgUser(service, { orgId: org, email: `sp-${tag}-owner-${randomUUID()}@example.test`, role: "owner" }).catch(() => null);
      if (owner) users.push(owner.userId);
    }
    const ua = await mk(BMH_ORG_ID, "a"); userA = ua.userId; a = clientForUser(ua.jwt);
    const ua2 = await mk(BMH_ORG_ID, "a2"); userA2 = ua2.userId; a2 = clientForUser(ua2.jwt);
    const ub = await mk(TEST_ORG_B_ID, "b"); userB = ub.userId; b = clientForUser(ub.jwt);
    anon = createClient<Database>(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    // The designation is trigger-guarded; set the same marker the guard expects.
    await db.query("begin");
    try {
      await db.query("select set_config('my_leads.designation_update', format('%s:%s:%s', auth.uid(), $1::uuid, $2::uuid), true)", [BMH_ORG_ID, userA2]);
      await db.query("update public.memberships set acquisitions_enabled = true where user_id = $1 and org_id = $2", [userA2, BMH_ORG_ID]);
      await db.query("commit");
    } catch (error) { await db.query("rollback"); throw error; }

    // --- fixtures (org A) ---
    const jane = await contact(BMH_ORG_ID, { first_name: "Jane", last_name: "Doe", email: "jane.doe@example.com", phone_1: "(555) 123-4567", phone_2: "555.222.3333" });
    const agent = await contact(BMH_ORG_ID, { first_name: "Agnes", last_name: "Brokerwell", email: "agnes@brokerage.test", phone_1: "+1 555 987 6543" });
    P.main = await property(BMH_ORG_ID, { address: "101 Zephyr Lane #2B", market: "Ozarks", apn: "APN-77-123", mls_number: "MLS998877", status: "prospect", homeowner_contact_id: jane, agent_contact_id: agent });
    // Same homeowner and agent across other statuses: every status must be returned.
    P.lead = await property(BMH_ORG_ID, { address: "102 Zephyr Lane", status: "new_lead", homeowner_contact_id: jane });
    P.dead = await property(BMH_ORG_ID, { address: "103 Zephyr Lane", status: "dead", homeowner_contact_id: jane });
    P.closed = await property(BMH_ORG_ID, { address: "104 Zephyr Lane", status: "closed", agent_contact_id: agent });
    P.deleted = await property(BMH_ORG_ID, { address: "105 Zephyr Lane", status: "prospect", homeowner_contact_id: jane, deleted_at: new Date().toISOString() });
    const obrien = await contact(BMH_ORG_ID, { first_name: "Sean", last_name: "O'Brien" });
    P.obrien = await property(BMH_ORG_ID, { address: "201 Kestrel Court", homeowner_contact_id: obrien });
    const hyphen = await contact(BMH_ORG_ID, { first_name: "Mary", last_name: "Smith-Jones" });
    P.hyphen = await property(BMH_ORG_ID, { address: "202 Kestrel Court", homeowner_contact_id: hyphen });
    const accent = await contact(BMH_ORG_ID, { first_name: "José", last_name: "Muñoz" });
    P.accent = await property(BMH_ORG_ID, { address: "203 Kestrel Court", homeowner_contact_id: accent });
    const entity = await contact(BMH_ORG_ID, { entity_name: "Doe Family Trust LLC" });
    P.entity = await property(BMH_ORG_ID, { address: "204 Kestrel Court", homeowner_contact_id: entity });
    const plus1 = await contact(BMH_ORG_ID, { first_name: "Plus", last_name: "Onecountry", phone_1: "+1 555 777 8888" });
    P.plus1 = await property(BMH_ORG_ID, { address: "205 Kestrel Court", homeowner_contact_id: plus1 });
    const phone101 = await contact(BMH_ORG_ID, { first_name: "Digitsonly", last_name: "Hundredone", phone_1: "555 101 0000" });
    P.phone101 = await property(BMH_ORG_ID, { address: "206 Kestrel Court", homeowner_contact_id: phone101 });
    P.cap = await property(BMH_ORG_ID, { address: ("Capcheck " + "z".repeat(91)).slice(0, 100) });
    const hundredOne = Array.from({ length: 101 }, (_, i) => ({ org_id: BMH_ORG_ID, address: `${2000 + i} Hundredone Heights`, city: "Springfield", state: "MO", zip: "65801" }));
    for (let i = 0; i < hundredOne.length; i += 51) {
      const { error } = await service.from("properties").insert(hundredOne.slice(i, i + 51));
      if (error) throw new Error(error.message);
    }
    // phone_3 only (no phone_1/phone_2): must still match by digits.
    const phone3 = await contact(BMH_ORG_ID, { first_name: "Thirdslot", last_name: "Lineowner", phone_3: "(913) 444-5555" });
    P.phone3 = await property(BMH_ORG_ID, { address: "207 Kestrel Court", homeowner_contact_id: phone3 });
    // An org-A property whose homeowner contact belongs to ORG B must not match through that contact.
    const foreign = await contact(TEST_ORG_B_ID, { first_name: "Foreignowner", last_name: "Crosslinkname", phone_1: "(913) 222-6666" });
    P.crossLinked = await property(BMH_ORG_ID, { address: "208 Kestrel Court" });
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      await db.query("update public.properties set homeowner_contact_id = $1 where id = $2", [foreign, P.crossLinked]);
      await db.query("commit");
    } catch (error) { await db.query("rollback"); throw error; }
    P.plain = await property(BMH_ORG_ID, { address: "300 Nothingmatches Road", city: "Dayton", state: "OH", zip: "45402" });
    // SMS vs non-SMS text.
    P.smsHit = await property(BMH_ORG_ID, { address: "400 Quillfeather Way" });
    await sms(BMH_ORG_ID, P.smsHit, null, "Please call me about the wombatplan offer");
    P.emailHit = await property(BMH_ORG_ID, { address: "401 Quillfeather Way" });
    await sms(BMH_ORG_ID, P.emailHit, null, "Email talks about the wombatplan too", "email");
    P.noConv = await property(BMH_ORG_ID, { address: "402 Quillfeather Way" });
    await sms(BMH_ORG_ID, P.noConv, null, "Orphan wombatplan note", "sms", null);
    // Literal wildcard / hostile-character fixtures.
    P.literalPct = await property(BMH_ORG_ID, { address: "50% Literal_Underscore Ave" });
    P.backslash = await property(BMH_ORG_ID, { address: "7 Back\\slash Street" });
    P.quote = await property(BMH_ORG_ID, { address: "9 Quote's \"Corner\" (Rear), Unit 3" });
    // One property that matches via ALL THREE branches (property text, contact, message).
    const triC = await contact(BMH_ORG_ID, { first_name: "Trebranch", last_name: "Owner" });
    P.tri = await property(BMH_ORG_ID, { address: "600 Trebranch Plaza", homeowner_contact_id: triC, agent_contact_id: triC });
    await sms(BMH_ORG_ID, P.tri, triC, "trebranch said yes");
    await sms(BMH_ORG_ID, P.tri, triC, "trebranch said yes again");
    // >100 rows for the "no row cap" check.
    const bulk = Array.from({ length: 130 }, (_, i) => ({ org_id: BMH_ORG_ID, address: `${1000 + i} Bulkville Boulevard`, city: "Springfield", state: "MO", zip: "65801" }));
    for (let i = 0; i < bulk.length; i += 65) {
      const { error } = await service.from("properties").insert(bulk.slice(i, i + 65));
      if (error) throw new Error(error.message);
    }
    // --- org B fixtures through each branch ---
    const bC = await contact(TEST_ORG_B_ID, { first_name: "Orgbonly", last_name: "Zephyr", phone_1: "(555) 123-4567", email: "orgb@example.com" });
    P.bProp = await property(TEST_ORG_B_ID, { address: "101 Zephyr Lane Orgbonly" });
    P.bContact = await property(TEST_ORG_B_ID, { address: "9 Elsewhere Rd", homeowner_contact_id: bC });
    P.bAgent = await property(TEST_ORG_B_ID, { address: "10 Elsewhere Rd", agent_contact_id: bC });
    P.bMsg = await property(TEST_ORG_B_ID, { address: "11 Elsewhere Rd" });
    await sms(TEST_ORG_B_ID, P.bMsg, null, "wombatplan from org b");
  }, 180000);

  afterAll(async () => {
    assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
    try {
      await db.query("begin");
      try { await db.query(migrationSql); await db.query("commit"); }
      catch (error) { await db.query("rollback"); throw error; }
      for (const id of users) await service.auth.admin.deleteUser(id);
      await resetTenantTables(service);
    } finally { await db.end(); }
  }, 120000);

  // ---------- stress #1: matching matrix ----------
  describe("matching matrix", () => {
    it("returns every status for one homeowner, never soft-deleted rows", async () => {
      const got = await ids("Jane Doe");
      expect(got).toEqual(sorted(P.main, P.lead, P.dead));
      expect(got).not.toContain(P.deleted);
    });
    it.each([
      ["(555) 123-4567"], ["555.123.4567"], ["5551234567"], ["555-123-4567"], ["123-4567"], ["4567"], ["555 222 3333"], ["2223333"],
    ])("matches homeowner phone_1/phone_2 typed as %s", async (q) => {
      const got = await ids(q);
      expect(got).toEqual(sorted(P.main, P.lead, P.dead));
    });
    it.each([["+1 555 987 6543"], ["555 987 6543"], ["5559876543"], ["6543"]])("matches agent phone typed as %s", async (q) => {
      expect(await ids(q)).toEqual(sorted(P.main, P.closed));
    });
    it("normalizes a leading 1 on 11-digit queries so +1 matches both storage styles", async () => {
      expect(await ids("+1 555 777 8888")).toEqual([P.plus1]); // stored with +1
      expect(await ids("555 777 8888")).toEqual([P.plus1]);
      expect(await ids("1-555-123-4567")).toEqual(sorted(P.main, P.lead, P.dead)); // stored without +1
      expect(await ids("+1 (555) 123-4567")).toEqual(sorted(P.main, P.lead, P.dead));
      // Only an exact 11-digit '1xxxxxxxxxx' is normalized; a 12-digit string is left alone.
      expect(await ids("1 555 123 4567 8")).toEqual([]);
    });
    it("phone-matches only structured queries (digit density like search_global)", async () => {
      for (const q of ["+1 555 123 4567", "(555) 123-4567", "555.123.4567", "+1 (555) 123-4567"]) {
        expect(await ids(q), q).toEqual(sorted(P.main, P.lead, P.dead));
      }
      // "101" is a phone fragment on the Hundredone contact, but "101 Zephyr" is text, not a phone.
      expect(await ids("101 Zephyr")).toEqual([P.main]);
      expect(await ids("101 Zephyr Lane")).toEqual([P.main]);
      expect(await ids("555 101 0000")).toEqual([P.phone101]);
    });
    it("matches a contact that only has phone_3", async () => {
      expect(await ids("913-444-5555")).toEqual([P.phone3]);
      expect(await ids("(913) 444 5555")).toEqual([P.phone3]);
      expect(await ids("Thirdslot")).toEqual([P.phone3]);
    });
    it("never matches an org-A property through a contact that belongs to another org", async () => {
      expect(await ids("Crosslinkname")).toEqual([]);
      expect(await ids("913-222-6666")).toEqual([]);
      expect(await ids("Crosslinkname", b)).toEqual([]); // org B cannot reach the org-A property either
    });
    it("tsquery metacharacters next to a real term still match (or not) correctly", async () => {
      expect(await ids("wombatplan:*")).toEqual([P.smsHit]);
      expect(await ids("wombatplan & offer")).toEqual([P.smsHit]);
      expect(await ids("!wombatplan")).toEqual([P.smsHit]);
      expect(await ids("(wombatplan)")).toEqual([P.smsHit]);
      expect(await ids("wombatplan | nothingelse")).toEqual([]); // sanitized to an AND of prefixes
      expect(await ids("wombat & plan")).toEqual([]); // 'plan' is not a prefix of any message token
      expect(await ids("wombat:* plan:*")).toEqual([]);
    });
    it("does not phone-match under 3 digits", async () => {
      expect(await ids("x12")).toEqual([]);
      expect(await ids("(12)")).toEqual([]);
    });
    it.each([
      ["o'brien", "obrien"], ["O'BRIEN", "obrien"], ["brien", "obrien"], ["sean o'brien", "obrien"],
      ["smith-jones", "hyphen"], ["jones", "hyphen"], ["mary smith", "hyphen"],
      ["josé", "accent"], ["MUÑOZ", "accent"], ["josé muñoz", "accent"],
      ["doe family trust", "entity"], ["DOE FAMILY TRUST LLC", "entity"], ["  doe family trust  ", "entity"],
    ])("matches name %s -> %s", async (q, key) => {
      expect(await ids(q)).toContain(P[key]);
    });
    it("collapses internal whitespace runs to one space", async () => {
      expect(await ids("doe  family")).toEqual([P.entity]);
      expect(await ids("doe \t\n  family   trust")).toEqual([P.entity]);
      expect(await ids("Jane    Doe")).toEqual(sorted(P.main, P.lead, P.dead));
    });
    it("matches homeowner entity names alongside same-surname people", async () => {
      expect(await ids("Doe")).toEqual(sorted(P.main, P.lead, P.dead, P.entity));
    });
    it("matches via the agent contact (not only the homeowner)", async () => {
      expect(await ids("Brokerwell")).toEqual(sorted(P.main, P.closed));
      expect(await ids("agnes@brokerage")).toEqual(sorted(P.main, P.closed));
    });
    it.each([["jane.doe@example"], ["EXAMPLE.COM"]])("matches partial email %s", async (q) => {
      expect(await ids(q)).toEqual(sorted(P.main, P.lead, P.dead));
    });
    it.each([
      ["101 zephyr lane", "main"], ["springfield", "main"], ["65801", "main"], ["ozarks", "main"],
      ["APN-77-123", "main"], ["mls998877", "main"], ["#2B", "main"], ["lane #2b", "main"], ["Dayton", "plain"], ["45402", "plain"],
    ])("matches property text %s", async (q, key) => {
      expect(await ids(q)).toContain(P[key]);
    });
    it("matches SMS text only for channel sms with a conversation", async () => {
      expect(await ids("wombatplan")).toEqual([P.smsHit]);
      expect(await ids("wombat")).toEqual([P.smsHit]);
    });
    it("include_messages=false suppresses message matches only", async () => {
      expect(await ids("wombatplan", a, false)).toEqual([]);
      expect(await ids("Jane Doe", a, false)).toEqual(sorted(P.main, P.lead, P.dead));
      expect(await ids("trebranch", a, false)).toEqual([P.tri]);
    });
    it("defaults include_messages to true when omitted", async () => {
      const { data, error } = await a.rpc("search_properties", { q: "wombatplan" }).select("id");
      expect(error).toBeNull();
      expect((data ?? []).map((r: { id: string }) => r.id)).toEqual([P.smsHit]);
    });
    it("guards length: <3 chars and whitespace return nothing; 100-char cap applies", async () => {
      expect(await ids("ab")).toEqual([]);
      expect(await ids("   ")).toEqual([]);
      expect(await ids("\tab")).toEqual([]);
      expect(await ids(" \t ab \n")).toEqual([]);
      expect(await ids("")).toEqual([]);
      const { data, error } = await a.rpc("search_properties", { q: null as unknown as string }).select("id");
      expect(error).toBeNull();
      expect(data).toEqual([]);
      // 100-char cap: the query is cut to 100 chars (then right-trimmed), never errors.
      expect(await ids("101 zephyr lane #2b" + " ".repeat(5))).toEqual([P.main]);
      const capAddr = ("Capcheck " + "z".repeat(91)).slice(0, 100);
      expect(capAddr).toHaveLength(100);
      expect(await ids(capAddr + "TAILBEYOND")).toEqual([P.cap]);
      // A match term that only exists past char 100 must not match.
      expect(await ids("x".repeat(100) + " zephyr")).toEqual([]);
      await ids("x".repeat(500));
    });
    it.each([
      ["%%%"], ["___"], ["\\\\\\"], ["a%b"], ["%"], ["_"], ["' or 1=1 --"], ["\"; drop table properties;--"], ["or(id.eq.1)"],
      ["foo:*"], ["a & b | !c"], ["(((((("], ["a,b,c"], ["😀😀😀"], ["\t\n \t\n x"], ["x".repeat(500)], ["\u0000ab".replace("\u0000", "")],
    ])("hostile input %j returns without error and without wildcard blow-up", async (q) => {
      expect(await ids(q)).toEqual([]);
    });
    it("treats % _ and \\ literally", async () => {
      expect(await ids("50% Literal")).toEqual([P.literalPct]);
      expect(await ids("literal_under")).toEqual([P.literalPct]);
      expect(await ids("literalXunder")).toEqual([]);
      expect(await ids("%%%")).toEqual([]);
      expect(await ids("___")).toEqual([]);
      expect(await ids("back\\slash")).toEqual([P.backslash]);
      expect(await ids("quote's \"corner\" (rear), unit")).toEqual([P.quote]);
    });
    it("never matches a message whose property is in a different org, deleted, or null", async () => {
      const cross = await property(BMH_ORG_ID, { address: "700 Crossorg Road" });
      await sms(TEST_ORG_B_ID, cross, null, "crossorgphrase mismatch"); // message org B, property org A
      const del = await property(BMH_ORG_ID, { address: "701 Deleteme Road", deleted_at: new Date().toISOString() });
      await sms(BMH_ORG_ID, del, null, "crossorgphrase deleted");
      await sms(BMH_ORG_ID, null, null, "crossorgphrase nullprop");
      expect(await ids("crossorgphrase")).toEqual([]);
      expect(await ids("crossorgphrase", b)).toEqual([]);
    });
    it("does not filter training rows in the RPC (app layer owns that)", async () => {
      const tc = await contact(BMH_ORG_ID, { first_name: "Dedicated", last_name: "Trainee" });
      const t = await property(BMH_ORG_ID, { address: "702 Trainingonly Road", is_training: true, status: "new_lead", homeowner_contact_id: tc });
      expect(await ids("Trainingonly")).toEqual([t]);
    });
    it("returns no rows for service-role (null auth.uid) and anonymous callers", async () => {
      const { data, error } = await service.rpc("search_properties", { q: "Zephyr" }).select("id");
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
    it("returns the same properties columns as the table (setof public.properties)", async () => {
      const { data, error } = await a.rpc("search_properties", { q: "101 Zephyr Lane" }).select("id, address, status, org_id");
      expect(error).toBeNull();
      expect(data).toEqual([{ id: P.main, address: "101 Zephyr Lane #2B", status: "prospect", org_id: BMH_ORG_ID }]);
    });
  });

  // ---------- stress #4: RPC-level count / pagination parity ----------
  describe("count and pagination parity", () => {
    it("one property matching via all three branches appears exactly once", async () => {
      expect(await ids("trebranch")).toEqual([P.tri]);
      const { count, data, error } = await a.rpc("search_properties", { q: "trebranch" }, { count: "exact" }).select("id");
      expect(error).toBeNull();
      expect(count).toBe(1);
      expect(data).toHaveLength(1);
    });
    it("has no row cap: >100 matches all returned, and count equals rows walked", async () => {
      const { count, error } = await a.rpc("search_properties", { q: "Bulkville" }, { count: "exact", head: true }).select("id");
      expect(error).toBeNull();
      expect(count).toBe(130);
      const walked: string[] = [];
      for (let from = 0; ; from += 25) {
        const { data, error: e } = await a.rpc("search_properties", { q: "Bulkville" }).select("id, address").order("address").range(from, from + 24);
        expect(e).toBeNull();
        walked.push(...(data ?? []).map((r: { id: string }) => r.id));
        if (!data || data.length < 25) break;
      }
      expect(walked).toHaveLength(130);
      expect(new Set(walked).size).toBe(130);
    });
    it("exactly 101 matches: count and rows are both 101 (no cap at 100)", async () => {
      const { count, error } = await a.rpc("search_properties", { q: "Hundredone Heights" }, { count: "exact", head: true }).select("id");
      expect(error).toBeNull();
      expect(count).toBe(101);
      expect(await ids("Hundredone Heights")).toHaveLength(101);
    });
    it("paginates a mixed three-branch match set without duplicates", async () => {
      // "zephyr" hits property text, contact text (last_name none) and agent contact paths.
      const all = await ids("Doe");
      const { count } = await a.rpc("search_properties", { q: "Doe" }, { count: "exact", head: true }).select("id");
      expect(count).toBe(all.length);
      const walked: string[] = [];
      for (let from = 0; from < all.length; from += 2) {
        const { data, error } = await a.rpc("search_properties", { q: "Doe" }).select("id, address").order("address").range(from, from + 1);
        expect(error).toBeNull();
        walked.push(...(data ?? []).map((r: { id: string }) => r.id));
      }
      expect(new Set(walked).size).toBe(all.length);
      expect(walked.sort()).toEqual(all);
    });
  });

  // ---------- stress #5: security ----------
  describe("security", () => {
    it.each([
      ["property branch", "Zephyr Lane Orgbonly"], ["homeowner contact branch", "Orgbonly"], ["agent contact branch", "orgb@example"],
      ["phone branch (org B contact shares digits)", "555 123 4567"], ["message branch", "wombatplan"],
    ])("org A never sees org B through the %s", async (_n, q) => {
      const got = await ids(q);
      for (const key of ["bProp", "bContact", "bAgent", "bMsg"]) expect(got).not.toContain(P[key]);
    });
    it.each([
      ["property branch", "Zephyr Lane Orgbonly", ["bProp"]], ["homeowner contact branch", "Orgbonly", ["bProp", "bContact", "bAgent"]],
      ["agent contact branch", "orgb@example", ["bContact", "bAgent"]], ["message branch", "wombatplan", ["bMsg"]],
    ])("org B sees only its own rows through the %s", async (_n, q, keys) => {
      expect(await ids(q, b)).toEqual(sorted(...keys.map(k => P[k])));
    });
    it("org B cannot see org A rows", async () => {
      for (const q of ["Zephyr", "Jane Doe", "wombatplan", "5559876543"]) {
        const got = await ids(q, b);
        for (const key of ["main", "lead", "smsHit", "tri"]) expect(got).not.toContain(P[key]);
      }
    });
    it.each([
      ["inactive", "access_status = 'suspended'"],
      ["expired", "access_expires_at = now() - interval '1 day'"],
      ["deletion-prepared", "deletion_prepared_at = now()"],
    ])("%s membership sees nothing through any branch with the same JWT", async (_n, update) => {
      const queries = ["101 Zephyr", "Brokerwell", "Jane Doe", "5559876543", "wombatplan"];
      for (const q of queries) expect((await ids(q)).length).toBeGreaterThan(0);
      try {
        await db.query(`update public.memberships set ${update} where user_id = $1 and org_id = $2`, [userA, BMH_ORG_ID]);
        for (const q of queries) expect(await ids(q)).toEqual([]);
      } finally {
        await db.query("update public.memberships set access_status='active', deletion_prepared_at=null, access_expires_at=null where user_id=$1 and org_id=$2", [userA, BMH_ORG_ID]);
      }
      for (const q of queries) expect((await ids(q)).length).toBeGreaterThan(0);
    });
    it("anonymous callers cannot execute the function", async () => {
      const { data, error } = await anon.rpc("search_properties", { q: "Zephyr" });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
    it("catalog: single signature, definer, postgres owner, restricted ACL, pinned search_path", async () => {
      const { rows } = await db.query(`select pronargs, provolatile, prosecdef, pg_get_userbyid(proowner) as owner, proconfig,
        has_function_privilege('anon', oid, 'execute') as anon,
        has_function_privilege('authenticated', oid, 'execute') as authenticated,
        has_function_privilege('service_role', oid, 'execute') as service
        from pg_proc where pronamespace = 'public'::regnamespace and proname = 'search_properties'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ pronargs: 2, provolatile: "s", prosecdef: true, owner: "postgres", anon: false, authenticated: true, service: true });
      expect(rows[0].proconfig).toContain("search_path=public, pg_temp");
    });
    it("restricted Acquisitions member calling with include_messages=true still gets message matches (documented app-layer parity)", async () => {
      expect(await ids("wombatplan", a2, true)).toEqual([P.smsHit]);
      // All statuses are visible too: restriction is enforced by the app layer, as with search_global.
      expect(await ids("Jane Doe", a2, true)).toEqual(sorted(P.main, P.lead, P.dead));
      expect(await ids("wombatplan", a2, false)).toEqual([]);
    });
  });
});
