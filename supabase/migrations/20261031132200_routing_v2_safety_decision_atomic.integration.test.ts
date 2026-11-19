import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { unwindRoutingV2After } from "@/lib/testing/routing-v2-db-unwind";

/**
 * 20261031132200 (Astra third review of b6a00a0a2f17): a safety decision and its effects commit
 * together; the apply gate blocks on any unrecovered safety obligation with no time exit; claim
 * leases on the DB clock; the sweep takes a property. Each test is rolled back.
 */
const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261031132200_routing_v2_safety_decision_atomic.sql";
const RB = path.join(__dirname, "../rollbacks");

beforeAll(() => db.connect());
afterAll(() => db.end());
afterEach(() => db.query("rollback"));

let org: string, property: string, contact: string, older: string, newer: string;
const STOP = { road: "stop", steps: [{ kind: "hold", reason: "asked_stop" }] };
const WHO = { road: "who_reply_drip", steps: [{ kind: "reply", key: "identity" }] };
const whoPlan = () => ({ road: "who_reply_drip", contact_id: contact, sequence_key: null, skip_first_step: false, outbox: [{ kind: "reply", slice: "replies", payload: { key: "identity" } }] });
const row = (id: string, action: { road: string; steps: unknown[] }) => ({ org_id: org, property_id: property, conversation_id: null, inbound_message_id: id, status: "decided", road: action.road, action, expected_revision: 0 });
const record = async (id: string, action: { road: string; steps: unknown[] }, reason: string | null) =>
  (await db.query("select public.routing_v2_record_live_decision($1::jsonb, $2) as r", [JSON.stringify(row(id, action)), reason])).rows[0].r as string;
const apply = async () => (await db.query("select routing_v2_apply_live_transition($1,$2,$3) as r", [newer, property, JSON.stringify(whoPlan())])).rows[0].r as { outcome: string };
const held = async () => (await db.query("select needs_human_attention h, hold_kind k, last_ai_escalation_reason r from properties where id = $1", [property])).rows[0];
const legacyDecision = (id: string, action: { road: string; steps: unknown[] } = STOP) =>
  db.query("insert into routing_v2_live_decisions(org_id,property_id,inbound_message_id,status,road,expected_revision,action) values ($1,$2,$3,'decided',$4,0,$5)", [org, property, id, action.road, JSON.stringify(action)]);

beforeEach(async () => {
  await db.query("begin");
  await unwindRoutingV2After(db, "20261031132200");
  await db.query(sql(M));
  org = randomUUID();
  await db.query("set local session_replication_role = replica");
  await db.query("insert into organizations(id,name) values($1,'safety atomic')", [org]);
  await db.query("insert into ai_responder_configs(org_id,system_prompt,routing_v2_flags) values($1,'test',$2)",
    [org, JSON.stringify({ questions_live: true, replies: true, drips: true, canary_percent: 100 })]);
  contact = (await db.query("insert into contacts(org_id,first_name,phone_1,phone_1_type) values($1,'Test','+18165550128','mobile') returning id", [org])).rows[0].id;
  property = (await db.query("insert into properties(org_id,address,state,status,homeowner_contact_id) values($1,'1 Atomic St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
  older = (await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,created_at) values($1,$2,$3,'inbound','sms','older',now()-interval '3 days') returning id", [org, property, contact])).rows[0].id;
  newer = (await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,created_at) values($1,$2,$3,'inbound','sms','newer',now()-interval '5 seconds') returning id", [org, property, contact])).rows[0].id;
  await db.query("insert into routing_v2_outbox (org_id, property_id, inbound_message_id, transition_seq, kind, engine, slice) values ($1,$2,$3,1,'reply','v2','replies')", [org, property, older]);
  await db.query("set local session_replication_role = origin");
  await legacyDecision(newer, WHO);
});

describe("A: routing_v2_record_live_decision", () => {
  it("a safety decision commits with its hold, effects recorded, pending v2 replies cancelled", async () => {
    expect(await record(older, STOP, "nine_asked_stop")).toBe("recorded");
    expect(await held()).toEqual({ h: true, k: "safety", r: "nine_asked_stop" });
    expect((await db.query("select effects_applied_at is not null as e from routing_v2_live_decisions where inbound_message_id = $1", [older])).rows[0].e).toBe(true);
    expect((await db.query("select status, cancel_reason from routing_v2_outbox where property_id = $1", [property])).rows[0]).toEqual({ status: "cancelled", cancel_reason: "held_for_person" });
  });
  it("if the hold cannot be written, nothing commits (no decision row)", async () => {
    await db.query(`create function pg_temp.refuse_hold() returns trigger language plpgsql as $$ begin raise exception 'forced hold failure'; end $$`);
    await db.query("create trigger refuse_hold before update of needs_human_attention on properties for each row execute function pg_temp.refuse_hold()");
    await db.query("savepoint s");
    await expect(record(older, STOP, "nine_asked_stop")).rejects.toThrow(/forced hold failure/);
    await db.query("rollback to savepoint s");
    expect((await db.query("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1", [older])).rows[0].n).toBe(0);
  });
  it("a non-safety decision is recorded without effects; a duplicate is reported", async () => {
    expect(await record(older, WHO, null)).toBe("recorded");
    expect((await held()).h).toBe(false);
    expect(await record(older, WHO, null)).toBe("duplicate");
  });
});

describe("B: the apply gate, no time exit", () => {
  it.each(["none", "processing", "completed", "error"] as const)("an unrecovered 3-day-old safety decision blocks (claim: %s)", async (state) => {
    await legacyDecision(older);
    if (state !== "none") {
      await db.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, error_message, lease_expires_at) values ($1,$2,$3,$4,$5,$6, now() - interval '3 days')",
        [org, older, property, contact, state, state === "error" ? "flag_failed" : null]);
    }
    expect((await apply()).outcome).toBe("held");
  });
  it("exit: the sweep's mark", async () => {
    await legacyDecision(older);
    await db.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, lease_expires_at) values ($1,$2,$3,$4,'processing', now() - interval '3 days')", [org, older, property, contact]);
    expect((await db.query("select public.routing_v2_mark_inbound_swept($1,'held') as r", [older])).rows[0].r).toBe(true);
    expect((await apply()).outcome).toBe("applied");
  });
  it("exit: a hold a person cleared records the effects (the lead then routes normally)", async () => {
    await legacyDecision(older);
    await db.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'nine_asked_stop' where id = $1", [property]);
    await db.query("update properties set needs_human_attention = false where id = $1", [property]);
    expect((await apply()).outcome).toBe("applied");
  });
  it("a v2 safety hold that could not be written (claim v2_safety_hold_failed) blocks until recovered", async () => {
    await db.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, error_message, lease_expires_at) values ($1,$2,$3,$4,'error','v2_safety_hold_failed', now() - interval '3 days')", [org, older, property, contact]);
    expect((await apply()).outcome).toBe("held");
    const cands = (await db.query("select id, why from public.routing_v2_sweep_candidates(300, 200, $1)", [property])).rows;
    expect(cands).toEqual([{ id: older, why: "safety_hold_failed" }]);
  });
});

describe("B/D: the sweep never ages an unrecovered obligation out; it takes a property", () => {
  it("a 3-day-old unrecovered safety decision is still a candidate, also when asked for this property only", async () => {
    await legacyDecision(older);
    const all = (await db.query("select id, why from public.routing_v2_sweep_candidates(300, 200) where property_id = $1", [property])).rows;
    expect(all).toEqual([{ id: older, why: "decision_unrecovered" }]);
    const mine = (await db.query("select id from public.routing_v2_sweep_candidates(300, 200, $1)", [property])).rows;
    expect(mine).toEqual([{ id: older }]);
    const other = (await db.query("select id from public.routing_v2_sweep_candidates(300, 200, $1)", [randomUUID()])).rows;
    expect(other).toEqual([]);
  });
});

describe("C: claim leases on the DB clock", () => {
  it("a claim written with an app clock an hour ahead is stored on now(), keeping its lease length; a release never moves it later", async () => {
    const ahead = (await db.query("select now() + interval '1 hour' as t")).rows[0].t as Date;
    const lease = new Date(ahead.getTime() + 5 * 60_000);
    await db.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, claimed_at, lease_expires_at) values ($1,$2,$3,$4,'processing',$5,$6)", [org, newer, property, contact, ahead, lease]);
    const c = (await db.query("select claimed_at = now() as on_db, lease_expires_at - claimed_at as len from ai_response_claims where inbound_message_id = $1", [newer])).rows[0];
    expect(c.on_db).toBe(true);
    expect(c.len).toMatchObject({ minutes: 5 });
    await db.query("update ai_response_claims set lease_expires_at = now() + interval '1 hour' where inbound_message_id = $1", [newer]);
    expect((await db.query("select lease_expires_at <= now() as ok from ai_response_claims where inbound_message_id = $1", [newer])).rows[0].ok).toBe(true);
  });
});

describe("rollback", () => {
  it("restores the previous bodies and drops the recorder and effects_applied_at", async () => {
    await db.query(sql(M, RB));
    expect((await db.query("select to_regprocedure('public.routing_v2_record_live_decision(jsonb,text)') is null as gone")).rows[0].gone).toBe(true);
    expect((await db.query("select count(*)::int n from information_schema.columns where table_name = 'routing_v2_live_decisions' and column_name = 'effects_applied_at'")).rows[0].n).toBe(0);
  });
});
