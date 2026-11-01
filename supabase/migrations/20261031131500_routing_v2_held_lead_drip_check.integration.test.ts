import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { unwindRoutingV2After } from "@/lib/testing/routing-v2-db-unwind";

/**
 * 20261031131500: routing_v2_enrollment_send_check refuses (and pauses) a v2 drip on a lead held
 * for a person, under the property lock right before the send. The hold here is written by plain
 * SQL: whatever path wrote it (outbox, webhook keyword / legal, a racing decision), no v2 drip
 * texts a held lead. Legacy enrollments are untouched. Each test is rolled back.
 */
const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261031131500_routing_v2_held_lead_drip_check.sql";
const RB = path.join(__dirname, "../rollbacks");

beforeAll(() => db.connect());
afterAll(() => db.end());
afterEach(() => db.query("rollback"));

type Ctx = { property: string; legacyProperty: string; v2: string; legacy: string };
let ctx: Ctx;

beforeEach(async () => {
  await db.query("begin");
  await unwindRoutingV2After(db, "20261031131500");
  await db.query(sql(M));
  const org = randomUUID();
  await db.query("set local session_replication_role = replica"); // fixtures only: bypass the v2 drip / enrollment guards
  await db.query("insert into organizations (id, name) values ($1, 'held drip check')", [org]);
  const contact = (await db.query("insert into contacts (org_id, first_name, last_name, phone_1) values ($1,'Pat','Held','+18165550111') returning id", [org])).rows[0].id;
  const property = (await db.query("insert into properties (org_id, address, state, status, homeowner_contact_id) values ($1,'1 Held St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
  await db.query("insert into ai_responder_configs (org_id, system_prompt, routing_v2_flags) values ($1,'x',$2::jsonb)", [org, JSON.stringify({ questions_live: true, drips: true, replies: true, canary_percent: 100 })]);
  const v2Seq = (await db.query("insert into sequences (org_id, name, active, routing_v2_key, routing_v2_version) values ($1,'Book appointment (v2 test)',false,'book_appointment',1) returning id", [org])).rows[0].id;
  const legacySeq = (await db.query("insert into sequences (org_id, name, active) values ($1,'Legacy drip',true) returning id", [org])).rows[0].id;
  const v2 = (await db.query("insert into sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at, routing_v2_engine, enrolled_at) values ($1,$2,$3,$4,'active',0,now(),'v2', now() - interval '1 hour') returning id", [org, v2Seq, property, contact])).rows[0].id;
  // One live enrollment per property: the legacy one sits on a second lead (held the same way).
  const legacyProperty = (await db.query("insert into properties (org_id, address, state, status, homeowner_contact_id) values ($1,'2 Held St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
  const legacy = (await db.query("insert into sequence_enrollments (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at) values ($1,$2,$3,$4,'active',0,now()) returning id", [org, legacySeq, legacyProperty, contact])).rows[0].id;
  await db.query("set local session_replication_role = origin");
  ctx = { property, legacyProperty, v2, legacy };
});

const check = async (id: string) => (await db.query("select public.routing_v2_enrollment_send_check($1) as r", [id])).rows[0].r as string;
const row = async (id: string) => (await db.query("select status, pause_reason from sequence_enrollments where id = $1", [id])).rows[0];
const hold = () => db.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'nine_asked_stop' where id = any($1)", [[ctx.property, ctx.legacyProperty]]);

describe("v2 drip send check: a lead held for a person gets no drip text", () => {
  it("not held: ok (unchanged)", async () => {
    expect(await check(ctx.v2)).toBe("ok");
    expect(await row(ctx.v2)).toEqual({ status: "active", pause_reason: null });
  });
  it("held by plain SQL: held_for_person, and the v2 drip is paused for the person", async () => {
    await hold();
    expect(await check(ctx.v2)).toBe("held_for_person");
    expect(await row(ctx.v2)).toEqual({ status: "paused", pause_reason: "inbound_reply" });
  });
  it("legacy enrollments are untouched on a held lead", async () => {
    await hold();
    expect(await check(ctx.legacy)).toBe("ok");
    expect(await row(ctx.legacy)).toEqual({ status: "active", pause_reason: null });
  });
  it("is idempotent; the rollback restores the previous body (a held lead is no longer refused)", async () => {
    await db.query(sql(M));
    await hold();
    await db.query(sql(M, RB));
    expect(await check(ctx.v2)).toBe("ok");
  });
});
