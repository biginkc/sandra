import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { unwindRoutingV2After } from "@/lib/testing/routing-v2-db-unwind";

/**
 * 20261030420000 (A-2 race analysis): hold scope, the one fenced hold writer, every hold pausing
 * the v2 drips, reply_pending, the hold-yield check and the DB-clock sweep helpers. Each test is
 * rolled back. Ordering is (created_at, id) in SQL.
 */
const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261030420000_routing_v2_hold_scope.sql";
const RB = path.join(__dirname, "../rollbacks");

beforeAll(() => db.connect());
afterAll(() => db.end());
afterEach(() => db.query("rollback"));

type Ctx = { org: string; contact: string; property: string; legacyProperty: string; v2: string; legacy: string; older: string; newer: string };
let ctx: Ctx;

async function inbound(property: string, contact: string, at: string, metadata: Record<string, unknown> = {}) {
  return (await db.query(
    "insert into messages (org_id, channel, direction, status, property_id, contact_id, from_address, to_address, body, created_at, metadata) values ($1,'sms','inbound','received',$2,$3,'+18165550123','+18165550199','hi',$4::timestamptz,$5::jsonb) returning id",
    [ctx.org, property, contact, at, JSON.stringify(metadata)],
  )).rows[0].id as string;
}

beforeEach(async () => {
  await db.query("begin");
  await unwindRoutingV2After(db, "20261030420000");
  await db.query(sql("20261030410000_routing_v2_held_lead_drip_check.sql"));
  await db.query(sql(M));
  const org = randomUUID();
  await db.query("set local session_replication_role = replica");
  await db.query("insert into organizations (id, name) values ($1, 'hold scope')", [org]);
  const contact = (await db.query("insert into contacts (org_id, first_name, last_name, phone_1) values ($1,'Pat','Scope','+18165550123') returning id", [org])).rows[0].id;
  const property = (await db.query("insert into properties (org_id, address, state, status, homeowner_contact_id) values ($1,'1 Scope St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
  const legacyProperty = (await db.query("insert into properties (org_id, address, state, status, homeowner_contact_id) values ($1,'2 Scope St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
  await db.query("insert into ai_responder_configs (org_id, system_prompt, routing_v2_flags) values ($1,'x',$2::jsonb)", [org, JSON.stringify({ questions_live: true, drips: true, replies: true, canary_percent: 100 })]);
  const v2Seq = (await db.query("insert into sequences (org_id, name, active, routing_v2_key, routing_v2_version) values ($1,'Book (scope test)',false,'book_appointment',1) returning id", [org])).rows[0].id;
  const legacySeq = (await db.query("insert into sequences (org_id, name, active) values ($1,'Legacy',true) returning id", [org])).rows[0].id;
  ctx = { org, contact, property, legacyProperty, v2: "", legacy: "", older: "", newer: "" };
  ctx.older = await inbound(property, contact, "2026-10-31T10:00:00Z");
  ctx.newer = await inbound(property, contact, "2026-10-31T10:01:00Z");
  ctx.v2 = (await db.query("insert into sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at, routing_v2_engine, routing_v2_inbound_id, enrolled_at) values ($1,$2,$3,$4,'active',0,now(),'v2',$5, now() - interval '1 hour') returning id", [org, v2Seq, property, contact, ctx.older])).rows[0].id;
  ctx.legacy = (await db.query("insert into sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at) values ($1,$2,$3,$4,'active',0,now()) returning id", [org, legacySeq, legacyProperty, contact])).rows[0].id;
  await db.query("set local session_replication_role = origin");
});

const prop = async (id = ctx.property) => (await db.query("select needs_human_attention, last_ai_escalation_reason, hold_kind, hold_inbound_message_id from properties where id = $1", [id])).rows[0];
const enr = async (id: string) => (await db.query("select status, pause_reason from sequence_enrollments where id = $1", [id])).rows[0];
const writeHold = async (inbound: string, reason: string, kind: string) => (await db.query("select public.routing_v2_write_hold($1,$2,$3,$4) as r", [ctx.property, inbound, reason, kind])).rows[0].r as string;

describe("routing_v2_write_hold: hold scope fenced by the newest inbound (M11)", () => {
  it("a mechanics hold about the NEWEST inbound is written, with its kind and inbound", async () => {
    expect(await writeHold(ctx.newer, "nine_reply_not_sent:provider_failed", "mechanics")).toBe("held");
    expect(await prop()).toEqual({ needs_human_attention: true, last_ai_escalation_reason: "nine_reply_not_sent:provider_failed", hold_kind: "mechanics", hold_inbound_message_id: ctx.newer });
  });
  it("M11: a mechanics hold about an OLDER inbound once a newer one exists: superseded, the lead is not held", async () => {
    expect(await writeHold(ctx.older, "nine_reply_not_sent:superseded_before_send", "mechanics")).toBe("superseded");
    expect((await prop()).needs_human_attention).toBe(false);
  });
  it("a safety hold is always written, even about an older inbound", async () => {
    expect(await writeHold(ctx.older, "nine_asked_stop", "safety")).toBe("held");
    expect(await prop()).toMatchObject({ needs_human_attention: true, hold_kind: "safety" });
  });
  it("never overwrites a hold; a safety hold upgrades a mechanics one (a newer text can then no longer clear it)", async () => {
    await writeHold(ctx.newer, "nine_reply_not_sent:provider_failed", "mechanics");
    expect(await writeHold(ctx.newer, "nine_reply_not_sent:other", "mechanics")).toBe("already_held");
    expect(await writeHold(ctx.newer, "nine_asked_stop", "safety")).toBe("upgraded");
    expect(await prop()).toMatchObject({ hold_kind: "safety", last_ai_escalation_reason: "nine_asked_stop" });
  });
});

describe("every hold pauses the v2 drips (M10, any writer) and a cleared hold carries no kind", () => {
  it("a plain SQL hold (UI / legacy writer) pauses the active v2 drip in the same transaction; legacy drips untouched", async () => {
    await db.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'keyword:legal_contract' where id = any($1)", [[ctx.property, ctx.legacyProperty]]);
    expect(await enr(ctx.v2)).toEqual({ status: "paused", pause_reason: "held_for_person" });
    expect(await enr(ctx.legacy)).toEqual({ status: "active", pause_reason: null });
    expect((await prop()).hold_kind).toBeNull(); // a legacy writer's hold has no kind = treated as safety
  });
  it("routing_v2_write_hold pauses too; clearing the hold clears kind and inbound and unpauses nothing", async () => {
    await writeHold(ctx.newer, "nine_reply_not_sent:provider_failed", "mechanics");
    expect(await enr(ctx.v2)).toEqual({ status: "paused", pause_reason: "held_for_person" });
    await db.query("update properties set needs_human_attention = false where id = $1", [ctx.property]);
    expect(await prop()).toMatchObject({ needs_human_attention: false, hold_kind: null, hold_inbound_message_id: null });
    expect((await enr(ctx.v2)).status).toBe("paused");
  });
});

describe("routing_v2_enrollment_send_check: a v2 drip waits for its own road's reply (F5)", () => {
  it("reply_pending while the reply queued by the enrolling inbound is pending; the drip stays active; ok once it is sent", async () => {
    const box = (await db.query("insert into routing_v2_outbox (org_id, property_id, inbound_message_id, transition_seq, kind, engine, slice, payload) values ($1,$2,$3,1,'reply','v2','replies','{}'::jsonb) returning id", [ctx.org, ctx.property, ctx.older])).rows[0].id;
    expect((await db.query("select public.routing_v2_enrollment_send_check($1) as r", [ctx.v2])).rows[0].r).toBe("reply_pending");
    expect((await enr(ctx.v2)).status).toBe("active");
    await db.query("update routing_v2_outbox set status = 'cancelled', cancel_reason = 'test' where id = $1", [box]);
    expect((await db.query("select public.routing_v2_enrollment_send_check($1) as r", [ctx.v2])).rows[0].r).toBe("ok");
  });
});

describe("person takeover vs the drip (stress §14)", () => {
  const check = async () => (await db.query("select public.routing_v2_enrollment_send_check($1) as r", [ctx.v2])).rows[0].r as string;
  it("M13 (DB): a takeover AFTER the enrolling inbound but stamped BEFORE the enrollment committed pauses the drip (person_took_over)", async () => {
    await db.query("update properties set last_person_takeover_at = '2026-10-31T10:30:00Z' where id = $1", [ctx.property]);
    expect(await check()).toBe("person_took_over");
    expect(await enr(ctx.v2)).toEqual({ status: "paused", pause_reason: "person_took_over" });
  });
  it("a takeover BEFORE the enrolling inbound does not stop the drip the seller's newer text started", async () => {
    await db.query("update properties set last_person_takeover_at = '2026-10-31T09:59:00Z' where id = $1", [ctx.property]);
    expect(await check()).toBe("ok");
  });
  it("routing_v2_mark_person_takeover stamps the DB clock under the routing lock", async () => {
    const before = (await db.query("select clock_timestamp() as t")).rows[0].t as Date;
    expect((await db.query("select public.routing_v2_mark_person_takeover(array[$1::uuid, $1::uuid]) as n", [ctx.property])).rows[0].n).toBe(1);
    const at = (await db.query("select last_person_takeover_at as t from properties where id = $1", [ctx.property])).rows[0].t as Date;
    expect(at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(await check()).toBe("person_took_over");
  });
});

describe("routing_v2_mechanics_hold_yields", () => {
  it("only an older mechanics hold yields to a newer inbound", async () => {
    const yields = async (inbound: string) => (await db.query("select public.routing_v2_mechanics_hold_yields($1,$2) as r", [ctx.property, inbound])).rows[0].r;
    await db.query("update properties set needs_human_attention = true, hold_kind = 'mechanics', hold_inbound_message_id = $2, last_ai_escalation_reason = 'nine_reply_not_sent:x' where id = $1", [ctx.property, ctx.older]);
    expect(await yields(ctx.newer)).toBe(true);
    expect(await yields(ctx.older)).toBe(false);
    await db.query("update properties set hold_kind = 'safety' where id = $1", [ctx.property]);
    expect(await yields(ctx.newer)).toBe(false);
  });
});

describe("sweep helpers on the DB clock (F3)", () => {
  const ids = async () => (await db.query("select id, why from public.routing_v2_sweep_candidates(300, 200) where property_id = $1", [ctx.property])).rows as Array<{ id: string; why: string }>;
  it("unstamped past the lease, a stale delayed stamp and an expired processing claim are candidates; young, keyword, decided and swept texts are not", async () => {
    await db.query("update messages set created_at = now() - interval '1 hour' where id = any($1)", [[ctx.older, ctx.newer]]);
    const young = await inbound(ctx.property, ctx.contact, new Date().toISOString());
    const keyword = await inbound(ctx.property, ctx.contact, new Date(Date.now() - 3600_000).toISOString(), { keyword: "help" });
    const delayed = await inbound(ctx.property, ctx.contact, new Date(Date.now() - 3600_000).toISOString(), { processing: { aiResponder: { outcome: "delayed", scheduledAt: new Date(Date.now() - 3600_000).toISOString() } } });
    const freshDelayed = await inbound(ctx.property, ctx.contact, new Date(Date.now() - 3600_000).toISOString(), { processing: { aiResponder: { outcome: "delayed", scheduledAt: new Date(Date.now() + 60_000).toISOString() } } });
    const claimed = await inbound(ctx.property, ctx.contact, new Date(Date.now() - 3600_000).toISOString(), { processing: { aiResponder: { outcome: "delayed", scheduledAt: new Date().toISOString() } } });
    await db.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, lease_expires_at) values ($1,$2,$3,$4,'processing', now() - interval '1 hour')", [ctx.org, claimed, ctx.property, ctx.contact]);
    await db.query("insert into routing_v2_live_decisions (org_id, property_id, inbound_message_id, status, expected_revision) values ($1,$2,$3,'decided',0)", [ctx.org, ctx.property, ctx.newer]);
    const got = new Map((await ids()).map((r) => [r.id, r.why]));
    expect(got.get(ctx.older)).toBe("unstamped");
    expect(got.get(delayed)).toBe("delayed_stale");
    expect(got.get(claimed)).toBe("claim_expired");
    for (const not of [young, keyword, freshDelayed, ctx.newer]) expect(got.has(not)).toBe(false);
    // The mark (server-side jsonb_set) removes it from the next pass; other metadata keys are kept.
    await db.query("update messages set metadata = metadata || '{\"other\": 1}'::jsonb where id = $1", [ctx.older]);
    expect((await db.query("select public.routing_v2_mark_inbound_swept($1, 'held') as r", [ctx.older])).rows[0].r).toBe(true);
    expect((await db.query("select metadata->'other' o, metadata->'processing'->'routingV2Sweep'->>'result' r from messages where id = $1", [ctx.older])).rows[0]).toEqual({ o: 1, r: "held" });
    expect(new Set((await ids()).map((r) => r.id)).has(ctx.older)).toBe(false);
  });
  it("the mark is never written on a completed responder stamp", async () => {
    const done = await inbound(ctx.property, ctx.contact, new Date().toISOString(), { processing: { aiResponder: { outcome: "auto_closed" } } });
    expect((await db.query("select public.routing_v2_mark_inbound_swept($1, 'held') as r", [done])).rows[0].r).toBe(false);
  });
});

describe("rollback", () => {
  it("restores the previous functions and drops the hold scope (a held lead no longer pauses drips by trigger)", async () => {
    await db.query(sql(M, RB));
    expect((await db.query("select count(*)::int n from information_schema.columns where table_name = 'properties' and column_name in ('hold_kind','hold_inbound_message_id')")).rows[0].n).toBe(0);
    expect((await db.query("select to_regprocedure('public.routing_v2_write_hold(uuid,uuid,text,text)') is null as gone")).rows[0].gone).toBe(true);
    await db.query("update properties set needs_human_attention = true where id = $1", [ctx.property]);
    expect((await enr(ctx.v2)).status).toBe("active");
  });
});
