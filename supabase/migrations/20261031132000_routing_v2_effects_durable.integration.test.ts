import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { unwindRoutingV2After } from "@/lib/testing/routing-v2-db-unwind";

/**
 * 20261031132000 (Astra review of a0c905d42390): decision/hold/cancel durability and DB-clock expiry.
 * Each test is rolled back.
 */
const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261031132000_routing_v2_effects_durable.sql";
const RB = path.join(__dirname, "../rollbacks");

beforeAll(() => db.connect());
afterAll(() => db.end());
afterEach(() => db.query("rollback"));

let ctx: { org: string; property: string; inbound: string };
const row = async (kind: "reply" | "alert") => (await db.query(
  "insert into routing_v2_outbox (org_id, property_id, inbound_message_id, transition_seq, kind, engine, slice, status, claimed_at, authorized_at) values ($1,$2,$3,1,$4,'v2',$5,'claimed',now(),now()) returning id",
  [ctx.org, ctx.property, ctx.inbound, kind, "replies"])).rows[0].id as string;
const fence = async (id: string) => (await db.query("select public.routing_v2_check_authorized_outbox_send($1,$2,$3) as r", [id, ctx.property, ctx.inbound])).rows[0].r as string;

beforeEach(async () => {
  await db.query("begin");
  await unwindRoutingV2After(db, "20261031132000");
  await db.query(sql(M));
  const org = randomUUID();
  await db.query("set local session_replication_role = replica");
  await db.query("insert into organizations (id, name) values ($1, 'effects durable')", [org]);
  const contact = (await db.query("insert into contacts (org_id, first_name, last_name, phone_1) values ($1,'Pat','Fence','+18165550126') returning id", [org])).rows[0].id;
  const property = (await db.query("insert into properties (org_id, address, state, status, homeowner_contact_id, is_dnc_locked) values ($1,'1 Fence St','MO','new_lead',$2,false) returning id", [org, contact])).rows[0].id;
  const inbound = (await db.query("insert into messages (org_id, channel, direction, status, property_id, contact_id, from_address, to_address, body, created_at) values ($1,'sms','inbound','received',$2,$3,'+18165550126','+18165550199','hi', now() - interval '1 minute') returning id", [org, property, contact])).rows[0].id;
  await db.query("insert into ai_responder_configs (org_id, system_prompt, routing_v2_flags) values ($1,'x',$2::jsonb)", [org, JSON.stringify({ questions_live: true, replies: true, drips: true, canary_percent: 100 })]);
  await db.query("insert into routing_v2_reply_transitions (org_id, property_id, inbound_message_id, inbound_at, transition_seq, outcome, decision) values ($1,$2,$3, now() - interval '1 minute', 1, 'applied', '{}'::jsonb)", [org, property, inbound]);
  await db.query("set local session_replication_role = origin");
  ctx = { org, property, inbound };
});

const enroll = async () => {
  await db.query("set local session_replication_role = replica");
  const seq = (await db.query("insert into sequences (org_id, name, active, routing_v2_key, routing_v2_version) values ($1,'NI (durable test)',false,'not_interested',1) returning id", [ctx.org])).rows[0].id;
  const contact = (await db.query("select homeowner_contact_id c from properties where id = $1", [ctx.property])).rows[0].c;
  const id = (await db.query("insert into sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at, routing_v2_engine, routing_v2_inbound_id) values ($1,$2,$3,$4,'active',0,now(),'v2',$5) returning id", [ctx.org, seq, ctx.property, contact, ctx.inbound])).rows[0].id as string;
  await db.query("set local session_replication_role = origin");
  return id;
};
const sendCheck = async (id: string) => (await db.query("select public.routing_v2_enrollment_send_check($1) as r", [id])).rows[0].r as string;
const notSent = async (id: string, reason: string) => (await db.query("select public.routing_v2_mark_outbox_not_sent($1,$2) as r", [id, reason])).rows[0].r as string;
const boxRow = async (id: string) => (await db.query("select status, cancel_reason, hold_pending from routing_v2_outbox where id = $1", [id])).rows[0];

describe("P1 #2: the not-sent cancel decides the handoff atomically", () => {
  it("a person case: cancelled with hold_pending; the drip waits (reply_pending) until the hold lands", async () => {
    const e = await enroll();
    const id = await row("reply");
    expect(await notSent(id, "reply_text_not_approved")).toBe("ok");
    expect(await boxRow(id)).toEqual({ status: "cancelled", cancel_reason: "not_sent:reply_text_not_approved", hold_pending: true });
    expect(await sendCheck(e)).toBe("reply_pending");
    await db.query("update routing_v2_outbox set hold_pending = false where id = $1", [id]);
    expect(await sendCheck(e)).toBe("ok");
  });
  it("overtaken by a newer text: cancelled only (no hold_pending)", async () => {
    const id = await row("reply");
    expect(await notSent(id, "superseded_by_newer_inbound")).toBe("ok_no_hold");
    expect((await boxRow(id)).hold_pending).toBe(false);
  });
  it("a mechanics no-op while this inbound's drip runs: cancelled only; without the drip: hold_pending", async () => {
    const withDrip = await row("reply");
    await enroll();
    expect(await notSent(withDrip, "template_already_sent")).toBe("ok_no_hold");
    await db.query("update sequence_enrollments set status = 'completed' where property_id = $1", [ctx.property]);
    const noDrip = (await db.query("insert into routing_v2_outbox (org_id, property_id, inbound_message_id, transition_seq, kind, engine, slice, status) values ($1,$2,$3,2,'reply','v2','replies','pending') returning id", [ctx.org, ctx.property, ctx.inbound])).rows[0].id;
    expect(await notSent(noDrip, "template_already_sent")).toBe("ok");
    expect((await boxRow(noDrip)).hold_pending).toBe(true);
  });
});

describe("P2 #3: reply age on the DB clock", () => {
  it("routing_v2_outbox_expired and the fence use now() - created_at (24 h)", async () => {
    const young = await row("reply");
    await db.query("update routing_v2_outbox set created_at = now() - interval '23 hours 30 minutes' where id = $1", [young]);
    expect((await db.query("select public.routing_v2_outbox_expired($1) as r", [young])).rows[0].r).toBe(false);
    expect(await fence(young)).toBe("ok");
    const old = (await db.query("insert into routing_v2_outbox (org_id, property_id, inbound_message_id, transition_seq, kind, engine, slice, status, claimed_at, authorized_at, created_at) values ($1,$2,$3,1,'reply','v2','replies','claimed',now(),now(), now() - interval '24 hours 30 minutes') returning id", [ctx.org, ctx.property, ctx.inbound])).rows[0].id;
    expect((await db.query("select public.routing_v2_outbox_expired($1) as r", [old])).rows[0].r).toBe(true);
    expect(await fence(old)).toBe("expired");
    expect(await boxRow(old)).toEqual({ status: "cancelled", cancel_reason: "expired", hold_pending: true });
  });
});

describe("P1 #1: a stored decision is not proof its effects landed", () => {
  it("the sweep takes a dead run (claim processing, lease long expired) even with a decision row", async () => {
    await db.query("update messages set created_at = now() - interval '20 minutes' where id = $1", [ctx.inbound]);
    await db.query("insert into routing_v2_live_decisions (org_id, property_id, inbound_message_id, status, expected_revision) values ($1,$2,$3,'failed',0)", [ctx.org, ctx.property, ctx.inbound]);
    const contact = (await db.query("select homeowner_contact_id c from properties where id = $1", [ctx.property])).rows[0].c;
    await db.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, lease_expires_at) values ($1,$2,$3,$4,'processing', now() - interval '1 hour')", [ctx.org, ctx.inbound, ctx.property, contact]);
    const ids = (await db.query("select id, why from public.routing_v2_sweep_candidates(300, 200) where property_id = $1", [ctx.property])).rows;
    expect(ids.map((r: { id: string }) => r.id)).toEqual([ctx.inbound]);
    await db.query("update ai_response_claims set status = 'completed', completed_at = now() where inbound_message_id = $1", [ctx.inbound]);
    expect((await db.query("select count(*)::int n from public.routing_v2_sweep_candidates(300, 200) where property_id = $1", [ctx.property])).rows[0].n).toBe(0);
  });
});

describe("rollback", () => {
  it("restores the previous bodies: the cancel no longer sets hold_pending; routing_v2_outbox_expired is gone", async () => {
    await db.query(sql(M, RB));
    const id = await row("reply");
    expect(await notSent(id, "reply_text_not_approved")).toBe("ok");
    expect((await boxRow(id)).hold_pending).toBe(false);
    expect((await db.query("select to_regprocedure('public.routing_v2_outbox_expired(uuid)') is null as gone")).rows[0].gone).toBe(true);
  });
});
