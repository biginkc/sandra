import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const sql = readFileSync("supabase/migrations/20260929237000_sequence_detail.sql", "utf8");
// Replays function DDL, so this suite runs only against the local scratch database.
const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
const pg = new Client({ connectionString: url });
let org: string;
let otherOrg: string;
let actor: string;
let source: string;
let target: string;
let otherSource: string;
let steps: string[];

async function asActor() {
  await pg.query("set local role authenticated");
  await pg.query("select set_config('request.jwt.claim.role','authenticated',true)");
  await pg.query("select set_config('request.jwt.claim.sub',$1,true)", [actor]);
}

async function rejected(sqlText: string, params: unknown[], code: string) {
  await pg.query("savepoint rejected_call");
  await asActor();
  await expect(pg.query(sqlText, params)).rejects.toMatchObject({ code });
  await pg.query("rollback to savepoint rejected_call");
  await pg.query("reset role");
}

beforeAll(async () => {
  await pg.connect();
  await pg.query(sql);
  await pg.query(sql);
});
afterAll(async () => { await pg.end(); });
beforeEach(async () => {
  await pg.query("begin");
  org = randomUUID(); otherOrg = randomUUID(); actor = randomUUID();
  source = randomUUID(); target = randomUUID(); otherSource = randomUUID();
  await pg.query("insert into auth.users(id) values ($1)", [actor]);
  await pg.query("insert into public.organizations(id,name) values ($1,'Detail A'),($2,'Detail B')", [org, otherOrg]);
  await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [actor, org]);
  await pg.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Source'),($3,$2,'Target'),($4,$5,'Other')",
    [source, org, target, otherSource, otherOrg]);
  const first = await pg.query<{ id: string }>("insert into public.sequence_steps(sequence_id,step_index,delay_after_previous_minutes,action_type,template_body) values ($1,0,0,'send_sms','First') returning id", [source]);
  const second = await pg.query<{ id: string }>("insert into public.sequence_steps(sequence_id,step_index,delay_after_previous_minutes,action_type,template_body) values ($1,1,1440,'send_sms','Second') returning id", [source]);
  steps = [first.rows[0].id, second.rows[0].id];
  await pg.query("insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','Other')", [otherSource]);
});
afterEach(async () => { await pg.query("rollback"); await pg.query("reset role"); });

it("copies ordered steps into an empty same-org target without changing the source", async () => {
  const original = (await pg.query("select step_index,delay_after_previous_minutes,action_type,template_body from public.sequence_steps where sequence_id=$1 order by step_index", [source])).rows;
  await asActor();
  expect((await pg.query("select public.sequence_copy_steps($1,$2) as copied", [target, source])).rows[0].copied).toBe(2);
  await pg.query("reset role");
  expect((await pg.query("select step_index,delay_after_previous_minutes,action_type,template_body from public.sequence_steps where sequence_id=$1 order by step_index", [target])).rows).toEqual(original);
  expect((await pg.query("select step_index,delay_after_previous_minutes,action_type,template_body from public.sequence_steps where sequence_id=$1 order by step_index", [source])).rows).toEqual(original);
  await rejected("select public.sequence_copy_steps($1,$2)", [target, source], "23514");
  await rejected("select public.sequence_copy_steps($1,$2)", [target, otherSource], "P0002");
  await rejected("select public.sequence_copy_steps($1,$2)", [source, source], "22023");
});

it("rejects a cross-org source and a nonempty target before writing", async () => {
  await rejected("select public.sequence_copy_steps($1,$2)", [target, otherSource], "P0002");
  expect((await pg.query("select count(*) from public.sequence_steps where sequence_id=$1", [target])).rows[0].count).toBe("0");
  await pg.query("insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','Existing')", [target]);
  await rejected("select public.sequence_copy_steps($1,$2)", [target, source], "23514");
  expect((await pg.query("select template_body from public.sequence_steps where sequence_id=$1", [target])).rows).toEqual([{ template_body: "Existing" }]);
});

it("counts distinct sends, replies after send, and active waiters for each step", async () => {
  async function enrollment(status: string, currentStep: number) {
    const property = randomUUID();
    const id = randomUUID();
    await pg.query("insert into public.properties(id,org_id,address,state) values ($1,$2,'Detail Lane','MO')", [property, org]);
    await pg.query("insert into public.sequence_enrollments(id,org_id,sequence_id,property_id,status,current_step_index) values ($1,$2,$3,$4,$5,$6)",
      [id, org, source, property, status, currentStep]);
    return { id, property };
  }
  async function message(property: string, direction: "inbound" | "outbound", created: string, sent?: string) {
    const result = await pg.query<{ id: string }>(`insert into public.messages(org_id,property_id,channel,direction,body,status,created_at,sent_at)
      values ($1,$2,'sms',$3,'Text',$4,$5,$6) returning id`, [org, property, direction, direction === "inbound" ? "received" : "sent", created, sent ?? null]);
    return result.rows[0].id;
  }
  async function run(id: string, step: string, messageId: string, at: string) {
    await pg.query("insert into public.sequence_step_runs(enrollment_id,step_id,scheduled_for,run_at,message_id) values ($1,$2,$3,$3,$4)", [id, step, at, messageId]);
  }
  const replied = await enrollment("active", 1);
  const noReply = await enrollment("completed", 2);
  const laterStep = await enrollment("active", 2);
  const unsent = await enrollment("active", 1);
  const sentAt = "2026-09-02T12:00:00Z";
  await run(replied.id, steps[0], await message(replied.property, "outbound", "2026-09-02T09:00:00Z", sentAt), "2026-09-02T09:00:00Z");
  await message(replied.property, "inbound", "2026-09-02T11:00:00Z"); // After run, before send: no reply.
  await message(replied.property, "inbound", "2026-09-02T13:00:00Z");
  await run(noReply.id, steps[0], await message(noReply.property, "outbound", "2026-09-02T09:00:00Z", sentAt), "2026-09-02T09:00:00Z");
  await message(noReply.property, "inbound", "2026-09-02T11:00:00Z"); // Must not count before sent_at.
  await run(laterStep.id, steps[0], await message(laterStep.property, "outbound", sentAt, sentAt), sentAt);
  await run(laterStep.id, steps[1], await message(laterStep.property, "outbound", "2026-09-03T12:00:00Z", "2026-09-03T12:00:00Z"), "2026-09-03T12:00:00Z");
  await message(laterStep.property, "inbound", "2026-09-03T13:00:00Z");
  await run(unsent.id, steps[0], await message(unsent.property, "outbound", sentAt), sentAt); // No sent_at.
  await asActor();
  const stats = await pg.query("select * from public.sequence_step_stats($1,$2)", [org, source]);
  expect(stats.rows).toEqual([
    { step_id: steps[0], sent: "3", replied: "1", waiting: "1" },
    { step_id: steps[1], sent: "1", replied: "1", waiting: "1" },
  ]);
  const overview = await pg.query("select finished_no_reply from public.sequence_overview_stats($1) where id=$2", [org, source]);
  expect(overview.rows[0].finished_no_reply).toBe("1");
  const needsPerson = await pg.query("select property_id from public.sequence_needs_person($1) where bucket='finished_no_reply'", [org]);
  expect(needsPerson.rows.map((row) => row.property_id)).toContain(noReply.property);
  expect(needsPerson.rows.map((row) => row.property_id)).not.toContain(replied.property);
  await pg.query("reset role");
  await rejected("select * from public.sequence_step_stats($1,$2)", [otherOrg, source], "42501");
});
