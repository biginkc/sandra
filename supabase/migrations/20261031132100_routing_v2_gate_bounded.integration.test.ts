import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { unwindRoutingV2After } from "@/lib/testing/routing-v2-db-unwind";

/**
 * 20261031132100 (Opus + Fable reviews of 531f2034f581, B1): the apply gate for "an older safety
 * decision has not completed" is bounded, and the sweep closes a dead run's claim. Each test is
 * rolled back.
 */
const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261031132100_routing_v2_gate_bounded.sql";
const RB = path.join(__dirname, "../rollbacks");

beforeAll(() => db.connect());
afterAll(() => db.end());
afterEach(() => db.query("rollback"));

let org: string, property: string, contact: string, older: string, newer: string;
const STOP = { road: "stop", steps: [{ kind: "hold", reason: "asked_stop" }] };
const WHO = { road: "who_reply_drip", steps: [{ kind: "reply", key: "identity" }] };
const whoPlan = () => ({ road: "who_reply_drip", contact_id: contact, sequence_key: null, skip_first_step: false, outbox: [{ kind: "reply", slice: "replies", payload: { key: "identity" } }] });
async function decide(id: string, action: { road: string; steps: unknown[] }) {
  await db.query("insert into routing_v2_live_decisions(org_id,property_id,inbound_message_id,status,road,expected_revision,action) select $1,$2,$3,'decided',$4,decision_context_revision,$5 from properties where id=$2",
    [org, property, id, action.road, JSON.stringify(action)]);
}
const claim = (id: string, status: string, leaseSql = "now() + interval '5 minutes'") =>
  db.query(`insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, lease_expires_at, error_message) values ($1,$2,$3,$4,$5, ${leaseSql}, $6)`,
    [org, id, property, contact, status, status === "error" ? "flag_failed" : null]);
const apply = async () => (await db.query("select routing_v2_apply_live_transition($1,$2,$3) as r", [newer, property, JSON.stringify(whoPlan())])).rows[0].r as { outcome: string };

beforeEach(async () => {
  await db.query("begin");
  await unwindRoutingV2After(db, "20261031132100");
  await db.query(sql(M));
  org = randomUUID();
  await db.query("set local session_replication_role = replica");
  await db.query("insert into organizations(id,name) values($1,'gate bounded')", [org]);
  await db.query("insert into ai_responder_configs(org_id,system_prompt,routing_v2_flags) values($1,'test',$2)",
    [org, JSON.stringify({ questions_live: true, replies: true, drips: true, canary_percent: 100 })]);
  contact = (await db.query("insert into contacts(org_id,first_name,phone_1,phone_1_type) values($1,'Test','+18165550127','mobile') returning id", [org])).rows[0].id;
  property = (await db.query("insert into properties(org_id,address,state,status,homeowner_contact_id) values($1,'1 Gate St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
  older = (await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,created_at) values($1,$2,$3,'inbound','sms','older',now()-interval '20 minutes') returning id", [org, property, contact])).rows[0].id;
  newer = (await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,created_at) values($1,$2,$3,'inbound','sms','newer',now()-interval '5 seconds') returning id", [org, property, contact])).rows[0].id;
  await db.query("set local session_replication_role = origin");
  await decide(older, STOP);
  await decide(newer, WHO);
});

describe("the apply gate: an older safety decision not completed", () => {
  it("in flight (claim processing, lease live): the newer text routes nothing ('held')", async () => {
    await claim(older, "processing");
    expect((await apply()).outcome).toBe("held");
  });
  it("completed: routes normally", async () => {
    await claim(older, "completed");
    expect((await apply()).outcome).toBe("applied");
  });
  it("the sweep handled it (mark + its claim closed): routes normally (a person cleared the hold)", async () => {
    await claim(older, "processing", "now() - interval '30 minutes'");
    expect((await db.query("select public.routing_v2_mark_inbound_swept($1,'held') as r", [older])).rows[0].r).toBe(true);
    expect((await db.query("select status, error_message from ai_response_claims where inbound_message_id = $1", [older])).rows[0]).toEqual({ status: "error", error_message: "lease_dead_swept" });
    expect((await apply()).outcome).toBe("applied");
  });
  it("a claim whose lease ran out over an hour ago counts as dead: routes normally", async () => {
    await claim(older, "processing", "now() - interval '2 hours'");
    expect((await apply()).outcome).toBe("applied");
  });
  it("an older ordinary (non-safety) decision never blocks", async () => {
    await db.query("update routing_v2_live_decisions set road = 'who_reply_drip', action = $2 where inbound_message_id = $1", [older, JSON.stringify(WHO)]);
    await claim(older, "processing");
    expect((await apply()).outcome).toBe("applied");
  });
});

describe("N-1: a safety decision whose hold write failed is re-attempted by the sweep", () => {
  it("claim error/flag_failed + safety decision + lead not held is a candidate; once held it is not", async () => {
    await claim(older, "error", "now() - interval '30 minutes'");
    await db.query("update ai_response_claims set updated_at = now() - interval '30 minutes' where inbound_message_id = $1", [older]);
    const ids = async () => (await db.query("select id, why from public.routing_v2_sweep_candidates(300, 200) where property_id = $1", [property])).rows;
    expect(await ids()).toEqual([{ id: older, why: "hold_failed" }]);
    await db.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'nine_asked_stop' where id = $1", [property]);
    expect(await ids()).toEqual([]);
  });
});

describe("rollback", () => {
  it("restores the 460000 gate: a swept older text blocks again", async () => {
    await db.query(sql(M, RB));
    await claim(older, "processing", "now() - interval '30 minutes'");
    await db.query("select public.routing_v2_mark_inbound_swept($1,'held')", [older]);
    expect((await apply()).outcome).toBe("held");
  });
});
