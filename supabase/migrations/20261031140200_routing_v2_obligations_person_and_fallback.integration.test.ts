import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { unwindRoutingV2After } from "@/lib/testing/routing-v2-db-unwind";

/**
 * 20261031140200 (Opus review of #956 at 36321be81c39: B1, B4, N2). Each test is rolled back.
 */
const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261031140200_routing_v2_obligations_person_and_fallback.sql";
const RB = path.join(__dirname, "../rollbacks");

beforeAll(() => db.connect());
afterAll(() => db.end());
afterEach(() => db.query("rollback"));

let org: string, property: string, contact: string, older: string, user: string;

beforeEach(async () => {
  await db.query("begin");
  await unwindRoutingV2After(db, "20261031140200");
  await db.query(sql(M));
  org = randomUUID();
  await db.query("set local session_replication_role = replica");
  await db.query("insert into organizations(id,name) values($1,'obligations person')", [org]);
  user = (await db.query("insert into auth.users(id, email) values (gen_random_uuid(), $1) returning id", [`p-${org}@example.invalid`])).rows[0].id;
  await db.query("insert into memberships(user_id, org_id, role, access_status) values ($1,$2,'owner','active')", [user, org]);
  contact = (await db.query("insert into contacts(org_id,first_name,phone_1,phone_1_type) values($1,'Test','+18165550129','mobile') returning id", [org])).rows[0].id;
  property = (await db.query("insert into properties(org_id,address,state,status,homeowner_contact_id) values($1,'4 Person St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
  older = (await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,created_at) values($1,$2,$3,'inbound','sms','older',now()-interval '3 days') returning id", [org, property, contact])).rows[0].id;
  await db.query("set local session_replication_role = origin");
});

const open = async (reason = "nine_asked_stop", inbound: string | null = older) =>
  (await db.query("select public.routing_v2_open_obligation($1,$2,$3,'hold_failed') as id", [property, inbound, reason])).rows[0].id as string;
const has = async () => (await db.query("select public.routing_v2_has_unresolved_obligation($1) as r", [property])).rows[0].r as boolean;
const held = async () => (await db.query("select needs_human_attention h, last_ai_escalation_reason r, last_ai_escalation_at::text a from properties where id = $1", [property])).rows[0];
const holdFor = (reason: string) => db.query("update properties set needs_human_attention = true, last_ai_escalation_reason = $2, last_ai_escalation_at = now() where id = $1", [property, reason]);
const resolveHold = async (action: "dismiss" | "take_over") => {
  const h = await held();
  return (await db.query("select public.fn_resolve_hold($1,$2,$3,$4,$5,$6,$7,$8) as r",
    [org, property, user, action, action === "dismiss" ? "handled" : null, new Date(Date.now() + 1000).toISOString(), h.r, h.a])).rows[0].r as Record<string, unknown>;
};

describe("B1: Messages v2 Dismiss / Take over resolve obligations as the person", () => {
  for (const action of ["dismiss", "take_over"] as const) {
    it(`${action}: a stacked obligation on the held lead is resolved (person) and the hold really ends; flagCleared true`, async () => {
      await holdFor("draft_held");
      await open("nine_asked_stop", null);
      expect(await has()).toBe(true);
      const r = await resolveHold(action);
      expect(r).toMatchObject({ status: "OK", flagCleared: true });
      expect((await held()).h).toBe(false);
      expect(await has()).toBe(false);
      expect((await db.query("select resolved_by from routing_v2_safety_obligations where property_id = $1", [property])).rows).toEqual([{ resolved_by: "person" }]);
    });
  }
  it("a stale card resolves nothing", async () => {
    await holdFor("draft_held");
    await open();
    const r = (await db.query("select public.fn_resolve_hold($1,$2,$3,'dismiss','x',$4,'something_else',now()) as r", [org, property, user, new Date().toISOString()])).rows[0].r;
    expect(r).toMatchObject({ status: "STALE" });
    expect(await has()).toBe(true);
  });
  it("a lead that is not held: Take over resolves no obligation", async () => {
    await open();
    await resolveHold("take_over");
    expect(await has()).toBe(true);
  });
  it("a clear a trigger keeps is reported flagCleared false", async () => {
    await holdFor("draft_held");
    await db.query("create function pg_temp.keep() returns trigger language plpgsql as $$ begin new.needs_human_attention := true; return new; end $$");
    await db.query(`create trigger zz_keep before update of needs_human_attention on public.properties for each row when (new.id = '${property}') execute function pg_temp.keep()`);
    expect(await resolveHold("dismiss")).toMatchObject({ status: "OK", flagCleared: false });
  });
});

describe("N2: a kept hold shows the OPEN obligation's reason", () => {
  it("an automated clear of R1 with R2 open leaves the hold showing R2", async () => {
    await holdFor("jev_dnc_needs_confirm");
    await open("nine_asked_stop", null);
    await db.query("update properties set needs_human_attention = false, last_ai_escalation_reason = null where id = $1", [property]);
    expect(await held()).toMatchObject({ h: true, r: "nine_asked_stop" });
  });
});

describe("B4: the fallback marker", () => {
  const mark = async (inbound: string | null = older) => (await db.query("select public.routing_v2_mark_obligation_unrecorded($1,$2,'keyword:legal_contract') as r", [property, inbound])).rows[0].r as boolean;
  const fallbackOpen = async () => (await db.query("select count(*)::int n from routing_v2_obligation_fallbacks where property_id = $1 and resolved_at is null", [property])).rows[0].n as number;
  it("without a claim: a claim-independent fallback record blocks through the one predicate; the sweep promotes it into an obligation", async () => {
    expect(await mark()).toBe(true);
    expect(await fallbackOpen()).toBe(1);
    expect(await has()).toBe(true);
    expect((await db.query("select count(*)::int n from ai_response_claims where inbound_message_id = $1", [older])).rows[0].n).toBe(0);
    expect((await db.query("select public.routing_v2_promote_unrecorded_markers(50, $1) as n", [property])).rows[0].n).toBe(1);
    expect(await fallbackOpen()).toBe(0);
    expect((await db.query("select reason from routing_v2_safety_obligations where property_id = $1 and resolved_at is null", [property])).rows).toEqual([{ reason: "keyword:legal_contract" }]);
    expect(await has()).toBe(true);
  });
  it("Astra B1 (both orders): the fallback record is always written; the claim is completed with the marker only by its owner (id + claimed_at as taken)", async () => {
    const c = (await db.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, status) values ($1,$2,$3,'processing') returning id, claimed_at::text t", [org, older, property])).rows[0];
    const claimRow = async () => (await db.query("select status, error_message from ai_response_claims where id = $1", [c.id])).rows;
    expect(await mark()).toBe(true); // no claim id: recorded on the inbound; the existing claim is untouched
    expect(await claimRow()).toEqual([{ status: "processing", error_message: null }]);
    expect(await fallbackOpen()).toBe(1);
    const markOwn = (claimedAt: string) => db.query("select public.routing_v2_mark_obligation_unrecorded($1,$2,'nine_asked_stop',$3,$4::timestamptz) as r", [property, older, c.id, claimedAt]).then((r) => r.rows[0].r as boolean);
    // Another run reclaims it (claimed_at moves; set directly: now() is fixed inside this transaction).
    await db.query("set local session_replication_role = replica");
    await db.query("update ai_response_claims set claimed_at = claimed_at + interval '1 second' where id = $1", [c.id]);
    await db.query("set local session_replication_role = origin");
    // Reverse order (Astra second pass): the stale owner still records the case durably (fallback row),
    // and leaves the reclaimed claim alone.
    expect(await markOwn(c.t)).toBe(true);
    expect(await claimRow()).toEqual([{ status: "processing", error_message: null }]);
    expect(await fallbackOpen()).toBe(1);
    expect(await has()).toBe(true);
    const fresh = (await db.query("select claimed_at::text t from ai_response_claims where id = $1", [c.id])).rows[0].t as string;
    expect(await markOwn(fresh)).toBe(true);
    expect(await claimRow()).toEqual([{ status: "completed", error_message: "v2_safety_obligation_unrecorded" }]);
  });
  it("Astra second pass: the sweep's not_v2 mark is refused for a text with an open fallback record or obligation (stamped safety_case)", async () => {
    const stamp = async () => (await db.query("select metadata->'processing'->'routingV2Sweep'->>'result' r from messages where id = $1", [older])).rows[0].r as string | null;
    await mark();
    await db.query("select public.routing_v2_mark_inbound_swept($1, 'not_v2')", [older]);
    expect(await stamp()).toBe("safety_case");
    await db.query("select public.routing_v2_promote_unrecorded_markers(50, $1)", [property]);
    await db.query("update messages set metadata = metadata #- '{processing,routingV2Sweep}' where id = $1", [older]);
    await db.query("select public.routing_v2_mark_inbound_swept($1, 'not_v2')", [older]);
    expect(await stamp()).toBe("safety_case"); // now an obligation about this inbound
  });
  it("a person's resolution and a suppression retire fallback records", async () => {
    await mark();
    await db.query("select public.routing_v2_resolve_obligations_by_person($1)", [property]);
    expect(await fallbackOpen()).toBe(0);
    expect(await has()).toBe(false);
    await mark();
    expect(await has()).toBe(true);
    await db.query("update properties set is_dnc_locked = true where id = $1", [property]);
    expect(await has()).toBe(false);
  });
  it("a marker without an inbound still blocks", async () => {
    expect(await mark(null)).toBe(true);
    expect(await has()).toBe(true);
  });
  it("a person's resolution and a suppression retire the marker", async () => {
    await mark();
    await db.query("select public.routing_v2_resolve_obligations_by_person($1)", [property]);
    expect(await has()).toBe(false);
    await mark();
    await db.query("update properties set is_dnc_locked = true where id = $1", [property]);
    expect(await has()).toBe(false);
  });
  it("the kept-hold reason falls back to the marker's reason", async () => {
    await holdFor("draft_held");
    await mark();
    await db.query("update properties set needs_human_attention = false where id = $1", [property]);
    expect(await held()).toMatchObject({ h: true, r: "keyword:legal_contract" });
  });
  it("fallback functions are service-role only", async () => {
    for (const fn of ["routing_v2_mark_obligation_unrecorded(uuid,uuid,text,uuid,timestamptz)", "routing_v2_promote_unrecorded_markers(integer,uuid)"]) {
      const acl = (await db.query("select has_function_privilege('authenticated', $1, 'execute') a, has_function_privilege('service_role', $1, 'execute') s", [`public.${fn}`])).rows[0];
      expect(acl).toEqual({ a: false, s: true });
    }
  });
});

describe("rollback", () => {
  it("restores 132300 / 150200 bodies and drops the fallback functions", async () => {
    await db.query(sql(M, RB));
    const def = (n: string) => db.query("select pg_get_functiondef($1::regprocedure) d", [n]).then((r) => r.rows[0].d as string);
    expect(await def("public.fn_resolve_hold(uuid,uuid,uuid,text,text,timestamptz,text,timestamptz)")).not.toContain("routing_v2_resolve_obligations_by_person");
    expect(await def("public.routing_v2_has_unresolved_obligation(uuid)")).not.toContain("v2_safety_obligation_unrecorded");
    expect((await db.query("select to_regprocedure('public.routing_v2_mark_obligation_unrecorded(uuid,uuid,text,uuid,timestamptz)') is null g")).rows[0].g).toBe(true);
    expect((await db.query("select to_regprocedure('public.routing_v2_promote_unrecorded_markers(integer,uuid)') is null g")).rows[0].g).toBe(true);
    expect((await db.query("select to_regclass('public.routing_v2_obligation_fallbacks') is null g")).rows[0].g).toBe(true);
    expect(await def("public.routing_v2_mark_inbound_swept(uuid,text)")).not.toContain("safety_case");
  });
});
