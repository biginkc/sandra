import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { unwindRoutingV2After } from "@/lib/testing/routing-v2-db-unwind";

/**
 * 20261031132300 (Astra fourth review of 7e6e72c13839): routing_v2_safety_obligations is the one
 * source of truth; one predicate gates the apply, the fence and the drip send check; only a
 * durable hold, a person or a suppression resolves. Each test is rolled back.
 */
const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261031132300_routing_v2_safety_obligations.sql";
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
  await unwindRoutingV2After(db, "20261031132300");
  await db.query(sql(M));
  org = randomUUID();
  await db.query("set local session_replication_role = replica");
  await db.query("insert into organizations(id,name) values($1,'safety obligations')", [org]);
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

const open = async (reason = "nine_asked_stop", source = "hold_failed", inbound: string | null = older) =>
  (await db.query("select public.routing_v2_open_obligation($1,$2,$3,$4) as id", [property, inbound, reason, source])).rows[0].id as string;
const has = async () => (await db.query("select public.routing_v2_has_unresolved_obligation($1) as r", [property])).rows[0].r as boolean;
const openCount = async () => (await db.query("select count(*)::int n from routing_v2_safety_obligations where property_id = $1 and resolved_at is null", [property])).rows[0].n as number;

describe("the obligation store and its one predicate", () => {
  it("open / reuse; the predicate sees it; a reclaim of the claim changes nothing", async () => {
    const id = await open();
    expect(await open()).toBe(id);
    expect(await has()).toBe(true);
    await db.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, error_message, lease_expires_at) values ($1,$2,$3,$4,'error','v2_safety_hold_failed', now())", [org, older, property, contact]);
    await db.query("update ai_response_claims set status = 'processing', error_message = null where inbound_message_id = $1", [older]);
    expect(await has()).toBe(true);
  });
  it("the apply gate blocks on it (any age, any claim state, any sweep mark); flags have no say", async () => {
    await open();
    await db.query("update messages set metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{processing}', '{\"routingV2Sweep\": {\"result\": \"not_v2\"}}'::jsonb) where id = $1", [older]);
    expect((await apply()).outcome).toBe("held");
  });
  it("the drip send check pauses the drip (held_for_person)", async () => {
    await db.query("set local session_replication_role = replica");
    const seq = (await db.query("insert into sequences (org_id, name, active, routing_v2_key, routing_v2_version) values ($1,'NI (obligation test)',false,'not_interested',1) returning id", [org])).rows[0].id;
    const e = (await db.query("insert into sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at, routing_v2_engine, routing_v2_inbound_id) values ($1,$2,$3,$4,'active',0,now(),'v2',$5) returning id", [org, seq, property, contact, older])).rows[0].id;
    await db.query("set local session_replication_role = origin");
    await open();
    expect((await db.query("select public.routing_v2_enrollment_send_check($1) as r", [e])).rows[0].r).toBe("held_for_person");
  });
  it("the outbox fence refuses an automatic reply (held_for_person)", async () => {
    const box = (await db.query("insert into routing_v2_outbox (org_id, property_id, inbound_message_id, transition_seq, kind, engine, slice, status, claimed_at, authorized_at) values ($1,$2,$3,1,'reply','v2','replies','claimed',now(),now()) returning id", [org, property, newer])).rows[0].id;
    await db.query("insert into routing_v2_reply_transitions (org_id, property_id, inbound_message_id, inbound_at, transition_seq, outcome, decision) values ($1,$2,$3, now(), 1, 'applied', '{}'::jsonb)", [org, property, newer]);
    await open();
    expect((await db.query("select public.routing_v2_check_authorized_outbox_send($1,$2,$3) as r", [box, property, newer])).rows[0].r).toBe("held_for_person");
  });
});

describe("resolution: only a durable hold, a person, or a suppression", () => {
  it("a safety hold that lands resolves its own obligation (same transaction)", async () => {
    expect((await db.query("select public.routing_v2_write_hold($1,$2,'nine_asked_stop','safety') as r", [property, older])).rows[0].r).toBe("held");
    expect(await openCount()).toBe(0);
    expect((await db.query("select resolved_by from routing_v2_safety_obligations where property_id = $1", [property])).rows[0].resolved_by).toBe("hold_durable");
  });
  it("stacked: on a lead already held for another reason the obligation stays open, and an automated clear keeps the hold", async () => {
    await db.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'jev_dnc_needs_confirm' where id = $1", [property]);
    expect((await db.query("select public.routing_v2_write_hold($1,$2,'nine_asked_stop','safety') as r", [property, older])).rows[0].r).toBe("already_held");
    expect(await openCount()).toBe(1);
    await db.query("update properties set needs_human_attention = false, last_ai_escalation_reason = null where id = $1 and last_ai_escalation_reason = 'jev_dnc_needs_confirm'", [property]);
    expect(await held()).toMatchObject({ h: true, k: "safety" });
  });
  it("a person resolves all of them; the clear then ends the hold", async () => {
    await db.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'jev_dnc_needs_confirm' where id = $1", [property]);
    await open("nine_asked_stop"); await open("keyword:legal_contract", "keyword", newer);
    expect((await db.query("select public.routing_v2_resolve_obligations_by_person($1) as n", [property])).rows[0].n).toBe(2);
    await db.query("update properties set needs_human_attention = false where id = $1", [property]);
    expect((await held()).h).toBe(false);
  });
  it("a suppression (DNC lock) resolves them", async () => {
    await open();
    await db.query("set local session_replication_role = replica");
    await db.query("update properties set is_dnc_locked = false where id = $1", [property]);
    await db.query("set local session_replication_role = origin");
    await db.query("update properties set is_dnc_locked = true where id = $1", [property]);
    expect((await db.query("select resolved_by from routing_v2_safety_obligations where property_id = $1", [property])).rows[0].resolved_by).toBe("suppression");
  });
  it("the sweep's recovery list: open obligations on an unheld, unsuppressed lead only", async () => {
    await open();
    expect((await db.query("select property_id from public.routing_v2_obligation_candidates(50, $1)", [property])).rows).toEqual([{ property_id: property }]);
    await db.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'x' where id = $1", [property]);
    expect((await db.query("select count(*)::int n from public.routing_v2_obligation_candidates(50, $1)", [property])).rows[0].n).toBe(0);
  });
});

describe("rollback", () => {
  it("drops the store and restores the previous bodies", async () => {
    await db.query(sql(M, RB));
    expect((await db.query("select to_regclass('public.routing_v2_safety_obligations') is null as gone")).rows[0].gone).toBe(true);
    expect((await db.query("select to_regprocedure('public.routing_v2_has_unresolved_obligation(uuid)') is null as gone")).rows[0].gone).toBe(true);
  });
});
