import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261030310000_routing_v2_live_transition_alerts_survive.sql";
let org: string, property: string, contact: string, inbound: string, legacySeq: string, legacy: string;

beforeAll(() => db.connect());
afterAll(() => db.end());
beforeEach(async () => {
  await db.query("begin");
  org = randomUUID();
  await db.query("insert into organizations(id,name) values($1,'alerts survive test')", [org]);
  await db.query("insert into ai_responder_configs(org_id,system_prompt,routing_v2_flags) values($1,'test',$2)",
    [org, JSON.stringify({ questions_live: true, replies: true, drips: true, canary_percent: 100 })]);
  contact = (await db.query("insert into contacts(org_id,first_name,phone_1,phone_1_type) values($1,'Test','+18165550100','mobile') returning id", [org])).rows[0].id;
  property = (await db.query("insert into properties(org_id,address,state,status,homeowner_contact_id) values($1,'1 Test St','MO','new_lead',$2) returning id", [org, contact])).rows[0].id;
  legacySeq = (await db.query("insert into sequences(org_id,name,active) values($1,'Asked who is texting',true) returning id", [org])).rows[0].id;
  await db.query("insert into sequence_steps(sequence_id,step_index,delay_after_previous_minutes,action_type,template_body) values($1,0,0,'send_sms','Identity'),($1,1,1440,'send_sms','Next day')", [legacySeq]);
  // A one-step legacy drip: its snapshot cannot skip the first step.
  const oneStep = (await db.query("insert into sequences(org_id,name,active) values($1,'Confirmed owner',true) returning id", [org])).rows[0].id;
  await db.query("insert into sequence_steps(sequence_id,step_index,delay_after_previous_minutes,action_type,template_body) values($1,0,0,'send_sms','Only step')", [oneStep]);
  await db.query(sql("20261030270000_routing_v2_legacy_drip_snapshots.sql"));
  await db.query(sql("20261030280000_routing_v2_skip_first_step.sql"));
  await db.query(sql("20261030290000_routing_v2_live_transition_guard.sql"));
  await db.query(sql(M));
  legacy = (await db.query("insert into sequence_enrollments(org_id,sequence_id,property_id,contact_id,status,current_step_index,next_run_at) values($1,$2,$3,$4,'active',0,now()) returning id", [org, legacySeq, property, contact])).rows[0].id;
  inbound = (await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body,created_at) values($1,$2,$3,'inbound','sms','Call me Tuesday 3pm',now()-interval '5 seconds') returning id", [org, property, contact])).rows[0].id;
});
afterEach(() => db.query("rollback"));

const callMe = { road: "ALERT_call_me", steps: [{ kind: "alert", reason: "call_me" }, { kind: "reply", key: "said_yes" }, { kind: "drip", drip: "Asked who is texting", skipFirstStep: true }] };
const callMePlan = () => ({
  road: "ALERT_call_me", contact_id: contact, sequence_key: "asked_who", skip_first_step: true,
  outbox: [
    { kind: "alert", slice: "replies", payload: { reason: "call_me", label: "x", dedupe_key: `hot:${inbound}`, when_time_only_off: false } },
    { kind: "reply", slice: "replies", payload: { key: "said_yes" } },
  ],
});
async function evidence(action: { road: string; steps: unknown[] } = callMe, id = inbound) {
  await db.query("insert into routing_v2_live_decisions(org_id,property_id,inbound_message_id,status,road,expected_revision,action) select $1,$2,$3,'decided',$4,decision_context_revision,$5 from properties where id=$2",
    [org, property, id, action.road, JSON.stringify(action)]);
}
const run = async (plan: unknown, id = inbound) => (await db.query("select routing_v2_apply_live_transition($1,$2,$3) as r", [id, property, JSON.stringify(plan)])).rows[0].r;
const outbox = async () => (await db.query("select kind, payload->>'reason' as reason from routing_v2_outbox where property_id=$1 and status='pending' order by kind", [property])).rows;
const legacyStatus = async () => (await db.query("select status from sequence_enrollments where id=$1", [legacy])).rows[0].status;

describe("live transition: owner alerts survive and missing drips are never silent", () => {
  it("call-me then 'Thanks' (newer inbound, not yet routed): exactly one alert, no reply, drip untouched (B1)", async () => {
    await evidence();
    await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body) values($1,$2,$3,'inbound','sms','Thanks')", [org, property, contact]);
    const r = await run(callMePlan());
    expect(r).toMatchObject({ outcome: "superseded", alerts_only_reason: "superseded", alerts_queued: 1 });
    expect(await outbox()).toEqual([{ kind: "alert", reason: "call_me" }]);
    expect(await legacyStatus()).toBe("active");
    const t = (await db.query("select outcome, new_enrollment_id from routing_v2_reply_transitions where inbound_message_id=$1", [inbound])).rows[0];
    expect(t).toEqual({ outcome: "superseded", new_enrollment_id: null });
    // Idempotent: a retry replays, no second alert.
    expect(await run(callMePlan())).toMatchObject({ replayed: true });
    expect(await outbox()).toHaveLength(1);
  });

  it("a newer reply that already transitioned still lets the older call-me alert through (B1)", async () => {
    await evidence();
    const thanks = (await db.query("insert into messages(org_id,property_id,contact_id,direction,channel,body) values($1,$2,$3,'inbound','sms','Thanks') returning id", [org, property, contact])).rows[0].id;
    await evidence({ road: "who_reply_drip", steps: [{ kind: "reply", key: "identity" }] }, thanks);
    expect(await run({ road: "who_reply_drip", contact_id: contact, sequence_key: null, skip_first_step: false, outbox: [{ kind: "reply", slice: "replies", payload: { key: "identity" } }] }, thanks)).toMatchObject({ outcome: "applied" });
    expect(await run(callMePlan())).toMatchObject({ outcome: "superseded", alerts_queued: 1 });
    expect(await outbox()).toEqual([{ kind: "alert", reason: "call_me" }, { kind: "reply", reason: null }]);
    // The newer reply is still the property's latest transition: its reply is not superseded.
    const latest = (await db.query("select inbound_message_id from routing_v2_reply_transitions where property_id=$1 and outcome<>'superseded' order by transition_seq desc limit 1", [property])).rows[0];
    expect(latest.inbound_message_id).toBe(thanks);
  });

  it("revision moved: alerts only (B1)", async () => {
    await evidence();
    await db.query("update properties set decision_context_revision=decision_context_revision+1 where id=$1", [property]);
    expect(await run(callMePlan())).toMatchObject({ outcome: "context_changed", alerts_queued: 1 });
    expect(await outbox()).toEqual([{ kind: "alert", reason: "call_me" }]);
    expect(await legacyStatus()).toBe("active");
  });

  it("no v2 drip for the road: refuses before retiring the current drip, alert kept (B2)", async () => {
    const action = { road: "ALERT_call_me", steps: [{ kind: "alert", reason: "call_me" }, { kind: "drip", drip: "Maybe later" }] };
    await evidence(action);
    const r = await run({ road: "ALERT_call_me", contact_id: contact, sequence_key: "maybe_later", skip_first_step: false, outbox: [callMePlan().outbox[0]] });
    expect(r).toMatchObject({ outcome: "no_sequence", alerts_queued: 1 });
    expect(await legacyStatus()).toBe("active");
    expect(await outbox()).toEqual([{ kind: "alert", reason: "call_me" }]);
  });

  it("skip-first on a one-step snapshot is no_sequence, not success (B2)", async () => {
    const action = { road: "confirmed_owner_drip", steps: [{ kind: "drip", drip: "Confirmed owner", skipFirstStep: true }] };
    await evidence(action);
    const r = await run({ road: "confirmed_owner_drip", contact_id: contact, sequence_key: "confirmed_owner", skip_first_step: true, outbox: [] });
    expect(r).toMatchObject({ outcome: "no_sequence", alerts_queued: 0 });
    expect(await legacyStatus()).toBe("active");
  });

  it("a fresh call-me applies normally", async () => {
    await evidence();
    expect(await run(callMePlan())).toMatchObject({ outcome: "applied" });
    expect(await legacyStatus()).toBe("completed");
    expect(await outbox()).toEqual([{ kind: "alert", reason: "call_me" }, { kind: "reply", reason: null }]);
  });

  it.each([
    ["an extra alert", { ...callMePlan(), outbox: [...callMePlan().outbox, { kind: "alert", slice: "replies", payload: { reason: "hot_yes" } }] }],
    ["a swapped reply", { ...callMePlan(), outbox: [{ kind: "reply", slice: "replies", payload: { key: "identity" } }] }],
    ["a swapped drip", { ...callMePlan(), sequence_key: "not_interested" }],
    ["a changed skip-first", { ...callMePlan(), skip_first_step: false }],
    ["an invented stop_drip", { ...callMePlan(), stop_drip_when_time_only_on: true }],
  ])("binds effects to stored evidence: refuses %s (N3)", async (_label, plan) => {
    await evidence();
    expect(await run(plan)).toMatchObject({ outcome: "evidence_mismatch" });
    expect(await outbox()).toEqual([]);
    expect(await legacyStatus()).toBe("active");
  });

  it("a caller may drop flag-gated effects", async () => {
    await evidence();
    expect(await run({ ...callMePlan(), sequence_key: null, skip_first_step: false, outbox: [callMePlan().outbox[0]] })).toMatchObject({ outcome: "applied" });
  });

  it("is idempotent, service-role only, and rolls back to the 290000 body", async () => {
    await db.query(sql(M));
    expect((await db.query("select has_function_privilege('authenticated','routing_v2_record_alerts_only(uuid,uuid,jsonb,text)','EXECUTE') as u, has_function_privilege('anon','routing_v2_apply_live_transition(uuid,uuid,jsonb)','EXECUTE') as a")).rows[0]).toEqual({ u: false, a: false });
    await db.query(sql("20261030310000_routing_v2_live_transition_alerts_survive.sql", path.join(__dirname, "../rollbacks")));
    const body = (await db.query("select prosrc from pg_proc where proname='routing_v2_apply_live_transition'")).rows[0].prosrc as string;
    const original = readFileSync(path.join(__dirname, "20261030290000_routing_v2_live_transition_guard.sql"), "utf8");
    expect(original).toContain(body);
    expect((await db.query("select to_regproc('public.routing_v2_record_alerts_only') as f")).rows[0].f).toBeNull();
  });
});
