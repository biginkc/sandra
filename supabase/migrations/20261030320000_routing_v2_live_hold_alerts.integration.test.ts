import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261030320000_routing_v2_live_hold_alerts.sql";
let org: string, property: string, contact: string, inbound: string, legacy: string;

beforeAll(() => db.connect());
afterAll(() => db.end());
beforeEach(async () => {
  await db.query("begin");
  org = randomUUID();
  await db.query("insert into organizations(id,name) values($1,'live hold test')", [org]);
  await db.query("insert into ai_responder_configs(org_id,system_prompt,routing_v2_flags) values($1,'test',$2)",
    [org, JSON.stringify({ questions_live: true, replies: true, drips: true, canary_percent: 100 })]);
  contact = (await db.query("insert into contacts(org_id,first_name,phone_1,phone_1_type) values($1,'Test','+18165550100','mobile') returning id", [org])).rows[0].id;
  property = (await db.query("insert into properties(org_id,address,state,status,homeowner_contact_id) values($1,'1 Test St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
  const seq = (await db.query("insert into sequences(org_id,name,active) values($1,'Legacy',true) returning id", [org])).rows[0].id;
  await db.query("insert into sequence_steps(sequence_id,step_index,delay_after_previous_minutes,action_type,template_body) values($1,0,0,'send_sms','Hi')", [seq]);
  legacy = (await db.query("insert into sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,current_step_index,next_run_at) values($1,$2,$3,$4,'active',0,now()) returning id", [org, seq, property, contact])).rows[0].id;
  for (const f of ["20261030280000_routing_v2_skip_first_step.sql", "20261030290000_routing_v2_live_transition_guard.sql", "20261030310000_routing_v2_live_transition_alerts_survive.sql", M]) await db.query(sql(f));
  inbound = (await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body) values($1,$2,$3,'inbound','sms','???') returning id", [org, property, contact])).rows[0].id;
  await db.query("insert into routing_v2_live_decisions(org_id,property_id,inbound_message_id,status,road,expected_revision,action) select $1,$2,$3,'decided','haiku_unsure',decision_context_revision,$4 from properties where id=$2",
    [org, property, inbound, JSON.stringify({ road: "haiku_unsure", steps: [{ kind: "hold", reason: "needs_person" }, { kind: "alert", reason: "haiku_unsure" }] })]);
});
afterEach(() => db.query("rollback"));

const alert = { kind: "alert", slice: "replies", payload: { reason: "haiku_unsure", label: "x", dedupe_key: "k", when_time_only_off: false } };
const run = async (plan: unknown) => (await db.query("select routing_v2_record_live_hold($1,$2,$3) as r", [inbound, property, JSON.stringify(plan)])).rows[0].r;
const outbox = async () => (await db.query("select kind, payload->>'reason' as reason from routing_v2_outbox where property_id=$1", [property])).rows;

describe("held live decision: owner alerts only", () => {
  it("queues exactly the stored alert once; no reply, drip untouched, never the latest transition", async () => {
    expect(await run({ road: "haiku_unsure", sequence_key: null, skip_first_step: false, outbox: [alert] })).toMatchObject({ outcome: "held", alerts_queued: 1 });
    expect(await run({ road: "haiku_unsure", sequence_key: null, skip_first_step: false, outbox: [alert] })).toMatchObject({ replayed: true });
    expect(await outbox()).toEqual([{ kind: "alert", reason: "haiku_unsure" }]);
    expect((await db.query("select status from sequence_enrollments where id=$1", [legacy])).rows[0].status).toBe("active");
    expect((await db.query("select outcome from routing_v2_reply_transitions where inbound_message_id=$1", [inbound])).rows[0].outcome).toBe("superseded");
  });
  it.each([
    ["a reply", { road: "haiku_unsure", outbox: [{ kind: "reply", slice: "replies", payload: { key: "identity" } }] }],
    ["an alert not in evidence", { road: "haiku_unsure", outbox: [{ ...alert, payload: { reason: "call_me" } }] }],
    ["a drip", { road: "haiku_unsure", sequence_key: "asked_who", outbox: [] }],
    ["another road", { road: "possible_stop", outbox: [alert] }],
  ])("refuses %s", async (_l, plan) => {
    expect(await run(plan)).toMatchObject({ outcome: "evidence_mismatch" });
    expect(await outbox()).toEqual([]);
  });
  it("needs live evidence; service role only; rolls back", async () => {
    await db.query("delete from routing_v2_live_decisions where inbound_message_id=$1", [inbound]);
    expect(await run({ road: "haiku_unsure", outbox: [alert] })).toMatchObject({ outcome: "evidence_missing" });
    expect((await db.query("select has_function_privilege('authenticated','routing_v2_record_live_hold(uuid,uuid,jsonb)','EXECUTE') as u")).rows[0].u).toBe(false);
    await db.query(sql(M));
    await db.query(sql("20261030320000_routing_v2_live_hold_alerts.sql", path.join(__dirname, "../rollbacks")));
    expect((await db.query("select to_regproc('public.routing_v2_record_live_hold') as f")).rows[0].f).toBeNull();
  });
});
