import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { unwindRoutingV2After } from "@/lib/testing/routing-v2-db-unwind";

/**
 * 20261031140000 (Fable N-1 / Opus N6): with model_stop_suppression on, a Jev-decided stop that
 * the database suppresses releases the stop hold its own decision wrote, in the same transaction.
 * Every other case keeps the hold. One rolled-back transaction per test; fully migrated stack.
 */
const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
/** A second session: holds the locks a concurrent phone action / recorder would hold. */
const other = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261031140000_routing_v2_model_stop_release_hold.sql";
const RB = path.join(__dirname, "../rollbacks");
const PHONE = "+18165550131";
const STOP = { road: "stop", steps: [{ kind: "hold", reason: "asked_stop" }] };

beforeAll(async () => { await db.connect(); await other.connect(); });
afterAll(async () => { await other.end(); await db.end(); });
afterEach(() => db.query("rollback"));

let org: string, property: string, contact: string, inbound: string, older: string;

const flags = (on: boolean) => db.query("update ai_responder_configs set routing_v2_flags = $2 where org_id = $1",
  [org, JSON.stringify({ questions_live: true, replies: true, model_stop_suppression: on, canary_property_ids: [property] })]);
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
const suppressed = async () => (await db.query("select count(*)::int n from sms_phone_suppressions where org_id = $1 and source = 'model_stop'", [org])).rows[0].n as number;
const clearedEvents = async () => (await db.query("select payload from lead_events where property_id = $1 and event_type = 'ai_escalation_cleared'", [property])).rows.map((r) => r.payload);

beforeEach(async () => {
  await db.query("begin");
  await unwindRoutingV2After(db, "20261031140000");
  await db.query(sql(M));
  org = randomUUID();
  await db.query("set local session_replication_role = replica");
  await db.query("insert into organizations(id,name) values($1,'model stop release')", [org]);
  await db.query("insert into ai_responder_configs(org_id,system_prompt,active) values($1,'test',true)", [org]);
  property = (await db.query("insert into properties(org_id,address,state,status) values($1,'1 Release St','MO','prospect') returning id", [org])).rows[0].id;
  older = (await db.query("insert into messages(org_id,property_id,channel,direction,body,from_address,created_at) values($1,$2,'sms','inbound','older',$3, now() - interval '1 day') returning id", [org, property, PHONE])).rows[0].id;
  inbound = (await db.query("insert into messages(org_id,property_id,channel,direction,body,from_address) values($1,$2,'sms','inbound','stop texting me',$3) returning id", [org, property, PHONE])).rows[0].id;
  await db.query("set local session_replication_role = origin");
  contact = (await db.query("insert into contacts(org_id,first_name,phone_1,phone_1_type) values($1,'Pat',$2,'mobile') returning id", [org, PHONE])).rows[0].id;
  await db.query("update properties set homeowner_contact_id = $2 where id = $1", [property, contact]);
  await flags(true);
});

describe("routing_v2_apply_model_stop_and_release", () => {
  it("flag on, Jev stop suppressed: the atomic stop hold of this inbound is released in the same transaction (audited)", async () => {
    expect(await record(inbound, "nine_asked_stop")).toBe("recorded");
    expect(await held()).toEqual({ h: true, r: "nine_asked_stop" });
    const r = await release();
    expect(r).toMatchObject({ status: "suppressed", hold: "released" });
    expect(await held()).toEqual({ h: false, r: null });
    expect(await suppressed()).toBe(1);
    expect(await clearedEvents()).toEqual([expect.objectContaining({ reason: "model_stop_suppressed", cleared_hold_reason: "nine_asked_stop", hold_inbound_message_id: inbound })]);
  });

  it("a retry of the same inbound (duplicate) is idempotent: still suppressed once, still released", async () => {
    await record(inbound, "nine_asked_stop");
    await release();
    expect(await release()).toMatchObject({ status: "duplicate", hold: "none" });
    expect(await held()).toEqual({ h: false, r: null });
    expect(await suppressed()).toBe(1);
  });

  it("flag off: nothing is suppressed and the hold stays (today's human review)", async () => {
    await flags(false);
    await record(inbound, "nine_asked_stop");
    expect(await release()).toMatchObject({ status: "flag_off", hold: "none" });
    expect(await held()).toEqual({ h: true, r: "nine_asked_stop" });
    expect(await suppressed()).toBe(0);
  });

  it("a hold about another inbound (an older safety hold) is never released by this stop", async () => {
    await record(older, "keyword:legal_contract");
    expect(await record(inbound, "nine_asked_stop")).toBe("recorded"); // already_held under the older reason
    expect(await release()).toMatchObject({ status: "suppressed", hold: "kept_other_hold" });
    expect(await held()).toEqual({ h: true, r: "keyword:legal_contract" });
  });

  it("a person / legacy hold (no kind, no inbound) is never released", async () => {
    await db.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'needs_reply' where id = $1", [property]);
    expect(await release()).toMatchObject({ status: "suppressed", hold: "kept_other_hold" });
    expect(await held()).toEqual({ h: true, r: "needs_reply" });
  });

  it("another unrecovered safety obligation of the lead (a v2_safety_hold_failed claim) keeps the hold", async () => {
    await record(inbound, "nine_asked_stop");
    await db.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, error_message, lease_expires_at) values ($1,$2,$3,$4,'error','v2_safety_hold_failed', now())", [org, older, property, contact]);
    expect(await release()).toMatchObject({ status: "suppressed", hold: "kept_other_obligation" });
    expect(await held()).toEqual({ h: true, r: "nine_asked_stop" });
    expect((await db.query("select error_message from ai_response_claims where inbound_message_id = $1", [older])).rows[0].error_message).toBe("v2_safety_hold_failed");
  });

  it("another decision whose effects never landed keeps the hold", async () => {
    await record(inbound, "nine_asked_stop");
    await db.query("insert into routing_v2_live_decisions (org_id, property_id, inbound_message_id, status, road, expected_revision, action) values ($1,$2,$3,'decided','stop',0,$4)", [org, property, older, JSON.stringify(STOP)]);
    expect(await release()).toMatchObject({ status: "suppressed", hold: "kept_other_obligation" });
    expect(await held()).toEqual({ h: true, r: "nine_asked_stop" });
  });

  it("Astra N1: an ordinary earlier decision (a normal reply, effects never recorded) is not an obligation: released", async () => {
    await db.query("insert into routing_v2_live_decisions (org_id, property_id, inbound_message_id, status, road, expected_revision, action) values ($1,$2,$3,'decided','who_reply_drip',0,$4)",
      [org, property, older, JSON.stringify({ road: "who_reply_drip", steps: [{ kind: "reply", key: "identity" }] })]);
    await record(inbound, "nine_asked_stop");
    expect(await release()).toMatchObject({ status: "suppressed", hold: "released" });
    expect(await held()).toEqual({ h: false, r: null });
  });

  it("Astra N1: an older safety decision the sweep already handled is not an obligation: released", async () => {
    await db.query("insert into routing_v2_live_decisions (org_id, property_id, inbound_message_id, status, road, expected_revision, action) values ($1,$2,$3,'decided','stop',0,$4)", [org, property, older, JSON.stringify(STOP)]);
    await db.query("update messages set metadata = jsonb_build_object('processing', jsonb_build_object('routingV2Sweep', jsonb_build_object('result','held'))) where id = $1", [older]);
    await record(inbound, "nine_asked_stop");
    expect(await release()).toMatchObject({ status: "suppressed", hold: "released" });
  });

  it("Astra N3: the phone lock is taken FIRST (same order as fn_routing_v2_phone_action_apply_all) and its wait is capped: phone busy -> not_eligible within ~2 s, nothing suppressed, hold kept", async () => {
    await record(inbound, "nine_asked_stop");
    await other.query("select pg_advisory_lock(hashtext('routing_v2_phone:' || $1::text || ':' || public.routing_v2_phone_digits($2)))", [org, PHONE]);
    try {
      const t0 = Date.now();
      expect(await release()).toMatchObject({ status: "not_eligible", reason: "lock_timeout", hold: "none" });
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      await other.query("select pg_advisory_unlock_all()");
    }
    expect(await suppressed()).toBe(0);
    expect(await held()).toEqual({ h: true, r: "nine_asked_stop" });
  });

  it("Astra N3: the property lock is taken only AFTER the suppression; if it stays busy the suppression stands and the hold is kept (capped wait)", async () => {
    // The hold as the atomic recorder writes it, without taking the property lock in this session
    // (the recorder's transaction-scoped lock would make the other session wait on this test).
    await db.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'nine_asked_stop', hold_kind = 'safety', hold_inbound_message_id = $2 where id = $1", [property, inbound]);
    await other.query("select pg_advisory_lock(hashtext('routing_v2:' || $1::text))", [property]);
    try {
      const t0 = Date.now();
      expect(await release()).toMatchObject({ status: "suppressed", hold: "kept_lock_timeout" });
      expect(Date.now() - t0).toBeLessThan(8000);
    } finally {
      await other.query("select pg_advisory_unlock_all()");
    }
    expect(await suppressed()).toBe(1);
    expect(await held()).toEqual({ h: true, r: "nine_asked_stop" });
  });

  it("Astra N2: a release a database guard refuses is not audited and reports kept_by_database", async () => {
    await record(inbound, "nine_asked_stop");
    await db.query(`create function pg_temp.keep_hold() returns trigger language plpgsql as $$ begin new.needs_human_attention := true; return new; end $$`);
    await db.query("create trigger keep_hold before update of needs_human_attention on properties for each row execute function pg_temp.keep_hold()");
    expect(await release()).toMatchObject({ status: "suppressed", hold: "kept_by_database" });
    expect(await held()).toMatchObject({ h: true });
    expect(await clearedEvents()).toEqual([]);
  });

  it("is service-role only", async () => {
    await db.query("savepoint a");
    await db.query("set local role authenticated");
    await expect(db.query("select public.routing_v2_apply_model_stop_and_release($1,$2,$3,$4,$5,'{}'::jsonb)", [org, PHONE, inbound, property, contact])).rejects.toThrow(/permission denied|FORBIDDEN/);
    await db.query("rollback to savepoint a");
  });
});

describe("rollback", () => {
  it("drops the wrapper and nothing else", async () => {
    await db.query(sql(M, RB));
    expect((await db.query("select to_regprocedure('public.routing_v2_apply_model_stop_and_release(uuid,text,uuid,uuid,uuid,jsonb)') is null as gone")).rows[0].gone).toBe(true);
    expect((await db.query("select to_regprocedure('public.fn_apply_model_stop_suppression(uuid,text,uuid,uuid,uuid,jsonb)') is not null as kept")).rows[0].kept).toBe(true);
  });
});
