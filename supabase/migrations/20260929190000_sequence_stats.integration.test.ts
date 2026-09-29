import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { loadTestEnv } from "@tests/integration/env";

const sql = readFileSync("supabase/migrations/20260929190000_sequence_stats.sql", "utf8");
const hideDeadSql = readFileSync("supabase/migrations/20260929230000_sequence_needs_person_hide_dead.sql", "utf8");
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
if (!url) throw new Error("Missing TEST_SUPABASE_DB_URL");
const pg = new Client({ connectionString: url });
let org = "";
let otherOrg = "";
let actor = "";
let sequence = "";
let otherSequence = "";
const ids: Record<string, string> = {};

async function role(userId: string) {
  await pg.query("set local role authenticated");
  await pg.query("select set_config('request.jwt.claim.role','authenticated',true)");
  await pg.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
}

beforeAll(async () => {
  await pg.connect();
  await pg.query(sql);
  await pg.query(sql); // idempotency is part of the contract.
  await pg.query(hideDeadSql);
  await pg.query(hideDeadSql);
});
afterAll(async () => { await pg.end(); });
beforeEach(async () => {
  await pg.query("begin");
  org = randomUUID(); otherOrg = randomUUID(); actor = randomUUID(); sequence = randomUUID(); otherSequence = randomUUID();
  await pg.query("insert into auth.users(id) values ($1)", [actor]);
  await pg.query("insert into public.organizations(id,name) values ($1,'Stats A'),($2,'Stats B')", [org, otherOrg]);
  await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [actor, org]);
  await pg.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Stats'),($3,$4,'Other')", [sequence, org, otherSequence, otherOrg]);
  await pg.query("insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','Test')", [sequence]);
  await pg.query("insert into public.sequence_steps(sequence_id,step_index,action_type,target_status) values ($1,1,'change_status','new_lead')", [sequence]);
  for (const key of ["waiting", "replied", "takeover", "failed", "reconcile", "stopped", "canceled", "finished", "answered", "beforeRun", "afterRun", "replyBeforeStatus", "needs"]) {
    ids[key] = randomUUID();
    await pg.query("insert into public.properties(id,org_id,address,state,outreach_dispo) values ($1,$2,$3,'MO',$4)",
      [ids[key], org, `Stats ${key}`, key === "needs" ? "needs_sequence" : null]);
  }
  for (const [key, status, reason] of [
    ["waiting", "active", null], ["replied", "paused", "inbound_reply"],
    ["takeover", "paused", "rep_sms_human_takeover"], ["failed", "paused", "provider_failed"],
    ["reconcile", "paused", "reconciliation_required"], ["stopped", "opted_out", null],
    ["canceled", "completed", null], ["finished", "completed", null], ["answered", "completed", null], ["beforeRun", "completed", null], ["afterRun", "completed", null], ["replyBeforeStatus", "completed", null],
  ] as const) {
    const enrollmentId = randomUUID();
    ids[`${key}Enrollment`] = enrollmentId;
    await pg.query(`insert into public.sequence_enrollments
      (id,org_id,sequence_id,property_id,status,pause_reason,enrolled_at)
      values ($1,$2,$3,$4,$5,$6,'2026-09-01T00:00:00Z')`,
    [enrollmentId, org, sequence, ids[key], status, reason]);
  }
  await pg.query(`insert into public.lead_events(org_id,property_id,actor_type,event_type,source_type,source_id)
    values ($1,$2,'system','sequence_canceled','sequence_enrollments.canceled',$3)`,
  [org, ids.canceled, ids.canceledEnrollment]);
  await pg.query(`insert into public.messages(org_id,property_id,channel,direction,body,status,created_at)
    values ($1,$2,'sms','inbound','Reply','received','2026-09-03T00:00:00Z')`, [org, ids.answered]);
  const step = await pg.query("select id from public.sequence_steps where sequence_id=$1 and step_index=0", [sequence]);
  for (const key of ["beforeRun", "afterRun"]) {
    const outbound = await pg.query(`insert into public.messages(org_id,property_id,channel,direction,body,status,created_at)
      values ($1,$2,'sms','outbound','Sent','sent','2026-09-03T00:00:00Z') returning id`,
    [org, ids[key]]);
    await pg.query(`insert into public.sequence_step_runs(enrollment_id,step_id,scheduled_for,run_at,message_id)
      values ($1,$2,'2026-09-03T00:00:00Z','2026-09-03T00:00:00Z',$3)`,
    [ids[`${key}Enrollment`], step.rows[0].id, outbound.rows[0].id]);
    await pg.query(`insert into public.messages(org_id,property_id,channel,direction,body,status,created_at)
      values ($1,$2,'sms','inbound','Reply','received',$3)`,
    [org, ids[key], key === "beforeRun" ? "2026-09-02T00:00:00Z" : "2026-09-04T00:00:00Z"]);
  }
  const sent = await pg.query(`insert into public.messages(org_id,property_id,channel,direction,body,status,created_at)
    values ($1,$2,'sms','outbound','Sent','sent','2026-09-03T11:00:00Z') returning id`,
  [org, ids.replyBeforeStatus]);
  await pg.query(`insert into public.sequence_step_runs(enrollment_id,step_id,scheduled_for,run_at,message_id)
    values ($1,$2,'2026-09-03T11:00:00Z','2026-09-03T11:00:00Z',$3)`,
  [ids.replyBeforeStatusEnrollment, step.rows[0].id, sent.rows[0].id]);
  await pg.query(`insert into public.messages(org_id,property_id,channel,direction,body,status,created_at)
    values ($1,$2,'sms','inbound','Reply','received','2026-09-03T12:00:00Z')`,
  [org, ids.replyBeforeStatus]);
  const statusStep = await pg.query("select id from public.sequence_steps where sequence_id=$1 and step_index=1", [sequence]);
  await pg.query(`insert into public.sequence_step_runs(enrollment_id,step_id,scheduled_for,run_at)
    values ($1,$2,'2026-09-03T13:00:00Z','2026-09-03T13:00:00Z')`,
  [ids.replyBeforeStatusEnrollment, statusStep.rows[0].id]);
});
afterEach(async () => { await pg.query("rollback"); await pg.query("reset role"); });

it("counts each plain-English bucket and excludes a later reply from no-reply", async () => {
  await role(actor);
  const result = await pg.query("select * from public.sequence_overview_stats($1)", [org]);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({
    step_count: "2", active_enrollment_count: "5", waiting: "1", replied: "2",
    couldnt_send: "2", stopped: "2", finished_no_reply: "2",
  });
});

it("returns finished, failed, and unassigned needs-sequence leads", async () => {
  await role(actor);
  const result = await pg.query("select * from public.sequence_needs_person($1)", [org]);
  const byProperty = Object.fromEntries(result.rows.map((row) => [row.property_id, row.bucket]));
  expect(byProperty[ids.finished]).toBe("finished_no_reply");
  expect(byProperty[ids.beforeRun]).toBe("finished_no_reply");
  expect(byProperty[ids.afterRun]).toBeUndefined();
  expect(byProperty[ids.replyBeforeStatus]).toBeUndefined();
  expect(byProperty[ids.failed]).toBe("couldnt_send");
  expect(byProperty[ids.reconcile]).toBe("couldnt_send");
  expect(byProperty[ids.needs]).toBe("needs_sequence");
  expect(byProperty[ids.answered]).toBeUndefined();
  expect(byProperty[ids.canceled]).toBeUndefined();
});

it("removes a lead from needs-person triage after it is marked Dead", async () => {
  await pg.query("update public.properties set status='dead' where id in ($1,$2,$3)", [ids.finished, ids.failed, ids.needs]);
  await role(actor);
  const result = await pg.query("select property_id from public.sequence_needs_person($1)", [org]);
  const listed = result.rows.map((row) => row.property_id);
  expect(listed).not.toContain(ids.finished);
  expect(listed).not.toContain(ids.failed);
  expect(listed).not.toContain(ids.needs);
});

it("uses only the latest enrollment: restarting clears finished and a later failed send takes its place", async () => {
  const newer = randomUUID();
  await pg.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Restarted')", [newer, org]);
  await pg.query(`insert into public.sequence_enrollments
    (id,org_id,sequence_id,property_id,status,enrolled_at)
    values ($1,$2,$3,$4,'active','2026-09-05T00:00:00Z')`,
  [randomUUID(), org, newer, ids.finished]);
  await role(actor);
  const active = await pg.query("select * from public.sequence_needs_person($1) where property_id=$2", [org, ids.finished]);
  expect(active.rows).toHaveLength(0);
  await pg.query("reset role");
  await pg.query(`update public.sequence_enrollments set status='paused', pause_reason='manual'
    where property_id=$1 and sequence_id=$2`, [ids.finished, newer]);
  await role(actor);
  const paused = await pg.query("select * from public.sequence_needs_person($1) where property_id=$2", [org, ids.finished]);
  expect(paused.rows).toHaveLength(0);
  await pg.query("reset role");
  await pg.query(`update public.sequence_enrollments set status='paused', pause_reason='provider_failed'
    where property_id=$1 and sequence_id=$2`, [ids.finished, newer]);
  await role(actor);
  const failed = await pg.query("select * from public.sequence_needs_person($1) where property_id=$2", [org, ids.finished]);
  expect(failed.rows).toMatchObject([{ bucket: "couldnt_send", sequence_id: newer }]);
});

it("counts all 501 extra leads and reaches the final page in stable property order", async () => {
  await pg.query(`insert into public.properties(id,org_id,address,state,outreach_dispo)
    select gen_random_uuid(),$1,'Bulk ' || n,'MO','needs_sequence'
    from generate_series(1,501) n`, [org]);
  await role(actor);
  const counts = await pg.query("select * from public.sequence_needs_person_counts($1)", [org]);
  expect(counts.rows[0].needs_sequence).toBe("502"); // The fixture has one existing needs-sequence lead.
  const first = await pg.query("select property_id from public.sequence_needs_person_page($1,'needs_sequence',0,100)", [org]);
  const last = await pg.query("select property_id from public.sequence_needs_person_page($1,'needs_sequence',500,100)", [org]);
  expect(first.rows).toHaveLength(100);
  expect(last.rows).toHaveLength(2);
  expect(new Set([...first.rows, ...last.rows].map((row) => row.property_id)).size).toBe(102);
  const ordered = await pg.query("select property_id from public.sequence_needs_person($1) where bucket='needs_sequence' order by property_id", [org]);
  expect(last.rows.map((row) => row.property_id)).toEqual(ordered.rows.slice(500).map((row) => row.property_id));
});

it("rejects an org without active membership", async () => {
  await role(actor);
  await expect(pg.query("select * from public.sequence_overview_stats($1)", [otherOrg]))
    .rejects.toMatchObject({ code: "42501" });
});
