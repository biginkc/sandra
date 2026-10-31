import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261030390000_routing_v2_flag_off_human_queue.sql";
let org: string, property: string, contact: string, inbound: string;

beforeAll(() => db.connect());
afterAll(() => db.end());
beforeEach(async () => {
  await db.query("begin");
  await db.query(sql(M));
  org = randomUUID();
  await db.query("insert into organizations(id,name) values($1,'flag off test')", [org]);
  await db.query("insert into ai_responder_configs(org_id,system_prompt,routing_v2_flags) values($1,'t',$2)", [org, JSON.stringify({ questions_live: true, replies: true, drips: true, canary_percent: 100 })]);
  contact = (await db.query("insert into contacts(org_id,first_name,phone_1,phone_1_type) values($1,'T','+18165550100','mobile') returning id", [org])).rows[0].id;
  property = (await db.query("insert into properties(org_id,address,state,status,homeowner_contact_id) values($1,'1 Test St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
  inbound = (await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body) values($1,$2,$3,'inbound','sms','Sure') returning id", [org, property, contact])).rows[0].id;
});
afterEach(() => db.query("rollback"));

async function v2Enrollment() {
  await db.query("set local routing_v2.allow_drip_edit = 'on'");
  const seq = (await db.query("insert into sequences(org_id,name,active,routing_v2_key,routing_v2_version) values($1,'Book appointment (routing v2) test',false,'book_appointment',9) returning id", [org])).rows[0].id;
  await db.query("insert into sequence_steps(sequence_id,step_index,delay_after_previous_minutes,action_type,template_body) values($1,0,1440,'send_sms','Hi')", [seq]);
  await db.query("set local routing_v2.allow_drip_edit = ''");
  return (await db.query("select public.routing_v2_enroll($1,$2,$3,$4,$5) as id", [org, property, contact, seq, inbound])).rows[0].id as string;
}
const flagsOff = (over: Record<string, unknown>) => db.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || $2::jsonb where org_id = $1", [org, JSON.stringify(over)]);
const prop = async () => (await db.query("select needs_human_attention, last_ai_escalation_reason from properties where id = $1", [property])).rows[0];
const run = async () => (await db.query("select public.routing_v2_stop_disabled() as r")).rows[0].r;

describe("flag-off rollback returns the lead to a person (A-5)", () => {
  it("drips switched off: the v2 drip stops (flag_off) and the lead is held needs_reply", async () => {
    const e = await v2Enrollment();
    await flagsOff({ drips: false });
    expect(await run()).toMatchObject({ enrollments_stopped: 1, returned_to_human_queue: 1 });
    expect((await db.query("select status, ended_reason from sequence_enrollments where id=$1", [e])).rows[0]).toEqual({ status: "completed", ended_reason: "flag_off" });
    expect(await prop()).toEqual({ needs_human_attention: true, last_ai_escalation_reason: "needs_reply" });
  });
  it("a queued auto reply cancelled by flag-off holds the lead; a cancelled owner alert alone does not", async () => {
    await db.query("insert into routing_v2_reply_transitions(org_id,property_id,inbound_message_id,inbound_at,transition_seq,outcome,decision) select org_id,property_id,id,created_at,1,'applied','{}' from messages where id=$1", [inbound]);
    await db.query("insert into routing_v2_outbox(org_id,property_id,inbound_message_id,transition_seq,kind,slice) values($1,$2,$3,1,'alert','replies')", [org, property, inbound]);
    await flagsOff({ replies: false });
    expect(await run()).toMatchObject({ outbox_cancelled: 1, returned_to_human_queue: 0 });
    expect((await prop()).needs_human_attention).toBe(false);
    await db.query("insert into routing_v2_outbox(org_id,property_id,inbound_message_id,transition_seq,kind,slice) values($1,$2,$3,1,'reply','replies')", [org, property, inbound]);
    expect(await run()).toMatchObject({ outbox_cancelled: 1, returned_to_human_queue: 1 });
    expect(await prop()).toEqual({ needs_human_attention: true, last_ai_escalation_reason: "needs_reply" });
  });
  it("an existing hold keeps its reason (first flag wins); flags on = nothing changes", async () => {
    await v2Enrollment();
    expect(await run()).toMatchObject({ enrollments_stopped: 0, returned_to_human_queue: 0 });
    await db.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'hot_lead' where id = $1", [property]);
    await flagsOff({ drips: false });
    expect(await run()).toMatchObject({ enrollments_stopped: 1, returned_to_human_queue: 0 });
    expect(await prop()).toEqual({ needs_human_attention: true, last_ai_escalation_reason: "hot_lead" });
  });
  it("rollback restores the 181000 body", async () => {
    await db.query(sql("20261030390000_routing_v2_flag_off_human_queue.sql", path.join(__dirname, "../rollbacks")));
    const src = (await db.query("select prosrc from pg_proc where proname = 'routing_v2_stop_disabled'")).rows[0].prosrc as string;
    expect(readFileSync(path.join(__dirname, "20261030181000_routing_v2_versioned_drips.sql"), "utf8")).toContain(src);
  });
});
