import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { unwindRoutingV2After } from "@/lib/testing/routing-v2-db-unwind";

/**
 * 20261031140300 (Opus N1 on #954): the model-stop release wrapper asks the one obligation store
 * (20261031140100) and never audits a release that did not happen. One rolled-back transaction
 * per test; fully migrated stack.
 */
const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261031140300_routing_v2_model_stop_release_obligations.sql";
const RB = path.join(__dirname, "../rollbacks");
const PHONE = "+18165550133";
const STOP = { road: "stop", steps: [{ kind: "hold", reason: "asked_stop" }] };

beforeAll(() => db.connect());
afterAll(() => db.end());
afterEach(() => db.query("rollback"));

let org: string, property: string, contact: string, inbound: string, older: string;

const record = async (id: string, reason: string) => (await db.query("select public.routing_v2_record_live_decision($1::jsonb, $2) as r", [JSON.stringify({
  org_id: org, property_id: property, conversation_id: null, inbound_message_id: id, status: "decided", road: "stop", action: STOP, expected_revision: 0,
}), reason])).rows[0].r as string;
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.query("savepoint svc");
  await db.query("set local role service_role");
  await db.query("select set_config('request.jwt.claim.role', 'service_role', true)");
  try {
    const out = await fn();
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claim.role', '', true)");
    await db.query("release savepoint svc");
    return out;
  } catch (e) {
    await db.query("rollback to savepoint svc");
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claim.role', '', true)");
    throw e;
  }
}
const release = (id = inbound) => asService(async () => (await db.query(
  "select public.routing_v2_apply_model_stop_and_release($1,$2,$3,$4,$5,$6::jsonb) as r",
  [org, PHONE, id, property, contact, JSON.stringify({ step: "asked_stop", signal: "asked_stop", probability: 0.93 })])).rows[0].r as Record<string, unknown>);
const held = async () => (await db.query("select needs_human_attention h, last_ai_escalation_reason r from properties where id = $1", [property])).rows[0];
const clearedEvents = async () => (await db.query("select payload from lead_events where property_id = $1 and event_type = 'ai_escalation_cleared'", [property])).rows.map((r) => r.payload);
const openObligations = async () => (await db.query("select count(*)::int n from routing_v2_safety_obligations where property_id = $1 and resolved_at is null", [property])).rows[0].n as number;

beforeEach(async () => {
  await db.query("begin");
  await unwindRoutingV2After(db, "20261031140300");
  await db.query(sql(M));
  org = randomUUID();
  await db.query("set local session_replication_role = replica");
  await db.query("insert into organizations(id,name) values($1,'model stop release obligations')", [org]);
  await db.query("insert into ai_responder_configs(org_id,system_prompt,active) values($1,'test',true)", [org]);
  property = (await db.query("insert into properties(org_id,address,state,status) values($1,'2 Release St','MO','prospect') returning id", [org])).rows[0].id;
  older = (await db.query("insert into messages(org_id,property_id,channel,direction,body,from_address,created_at) values($1,$2,'sms','inbound','older',$3, now() - interval '1 day') returning id", [org, property, PHONE])).rows[0].id;
  inbound = (await db.query("insert into messages(org_id,property_id,channel,direction,body,from_address) values($1,$2,'sms','inbound','stop texting me',$3) returning id", [org, property, PHONE])).rows[0].id;
  await db.query("set local session_replication_role = origin");
  contact = (await db.query("insert into contacts(org_id,first_name,phone_1,phone_1_type) values($1,'Pat',$2,'mobile') returning id", [org, PHONE])).rows[0].id;
  await db.query("update properties set homeowner_contact_id = $2 where id = $1", [property, contact]);
  await db.query("update ai_responder_configs set routing_v2_flags = $2 where org_id = $1",
    [org, JSON.stringify({ questions_live: true, replies: true, model_stop_suppression: true, canary_property_ids: [property] })]);
});

describe("routing_v2_apply_model_stop_and_release on the obligation store", () => {
  it("suppressed Jev stop with ANOTHER unresolved obligation on the lead: the hold is kept, no ai_escalation_cleared", async () => {
    expect(await record(inbound, "nine_asked_stop")).toBe("recorded");
    // An older safety text whose hold could not be written (no decision row, no failed claim: the store only).
    await db.query("select public.routing_v2_open_obligation($1, $2, 'nine_asked_stop', 'hold_failed')", [property, older]);
    expect(await release()).toMatchObject({ status: "suppressed", hold: "kept_other_obligation" });
    expect(await held()).toMatchObject({ h: true });
    expect(await clearedEvents()).toEqual([]);
  });

  it("no other obligation: released and audited exactly once", async () => {
    expect(await record(inbound, "nine_asked_stop")).toBe("recorded");
    expect(await openObligations()).toBe(0); // this inbound's own obligation resolved with its durable hold
    expect(await release()).toMatchObject({ status: "suppressed", hold: "released" });
    expect(await held()).toEqual({ h: false, r: null });
    expect(await clearedEvents()).toEqual([expect.objectContaining({ reason: "model_stop_suppressed", hold_inbound_message_id: inbound })]);
  });

  it("the old signals alone no longer decide: a v2_safety_hold_failed claim without an obligation does not keep the hold", async () => {
    await record(inbound, "nine_asked_stop");
    await db.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, error_message, lease_expires_at) values ($1,$2,$3,$4,'error','v2_safety_hold_failed', now())", [org, older, property, contact]);
    expect(await release()).toMatchObject({ status: "suppressed", hold: "released" });
  });

  it("a keep-trigger re-hold is never audited as cleared (the wrapper re-reads the hold)", async () => {
    await record(inbound, "nine_asked_stop");
    // A BEFORE trigger that keeps the hold regardless (stands in for any re-hold after the check).
    await db.query("create function pg_temp.keep_hold() returns trigger language plpgsql as $$ begin new.needs_human_attention := true; return new; end $$");
    await db.query(`create trigger zz_test_keep_hold before update of needs_human_attention on public.properties for each row when (new.id = '${property}') execute function pg_temp.keep_hold()`);
    expect(await release()).toMatchObject({ status: "suppressed", hold: "kept_by_database" });
    expect(await held()).toMatchObject({ h: true });
    expect(await clearedEvents()).toEqual([]);
  });

  it("the fallback marker alone (no obligation row) also keeps the hold", async () => {
    expect(await record(inbound, "nine_asked_stop")).toBe("recorded");
    await db.query("select public.routing_v2_mark_obligation_unrecorded($1, $2, 'nine_asked_stop')", [property, older]);
    expect(await release()).toMatchObject({ status: "suppressed", hold: "kept_other_obligation" });
    expect(await clearedEvents()).toEqual([]);
  });
});

describe("rollback", () => {
  it("restores 20261031140000's body (old signals) exactly", async () => {
    await db.query(sql("20261031140300_routing_v2_model_stop_release_obligations.sql", RB));
    const def = (await db.query("select pg_get_functiondef('public.routing_v2_apply_model_stop_and_release(uuid,text,uuid,uuid,uuid,jsonb)'::regprocedure) d")).rows[0].d as string;
    expect(def).toContain("effects_applied_at is null");
    expect(def).not.toContain("public.routing_v2_has_unresolved_obligation(p_property_id)");
  });
});
