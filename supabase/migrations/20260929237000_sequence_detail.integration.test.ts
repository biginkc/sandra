import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const sql = readFileSync("supabase/migrations/20260929237000_sequence_detail.sql", "utf8");
// Replays function DDL, so this suite runs only against the local scratch database.
const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
const pg = new Client({ connectionString: url });
const preservedFunctions = ["sequence_overview_stats(uuid)", "sequence_needs_person(uuid)"];
let originalDefinitions: string[];
let org: string;
let otherOrg: string;
let actor: string;
let owner: string;
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
  await pg.query("begin");
  originalDefinitions = await Promise.all(preservedFunctions.map(async (signature) => {
    const result = await pg.query<{ definition: string }>("select pg_get_functiondef($1::regprocedure) as definition", [`public.${signature}`]);
    return result.rows[0].definition;
  }));
  await pg.query(sql);
  await pg.query(sql);
});
afterAll(async () => { await pg.query("rollback"); await pg.end(); });
beforeEach(async () => {
  await pg.query("savepoint detail_test");
  org = randomUUID(); otherOrg = randomUUID(); actor = randomUUID(); owner = randomUUID();
  source = randomUUID(); target = randomUUID(); otherSource = randomUUID();
  await pg.query("insert into auth.users(id) values ($1),($2)", [owner, actor]);
  await pg.query("insert into public.organizations(id,name) values ($1,'Detail A'),($2,'Detail B')", [org, otherOrg]);
  await pg.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active')", [owner, org]);
  await pg.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'member','active')", [actor, org]);
  await pg.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Source'),($3,$2,'Target'),($4,$5,'Other')",
    [source, org, target, otherSource, otherOrg]);
  const first = await pg.query<{ id: string }>("insert into public.sequence_steps(sequence_id,step_index,delay_after_previous_minutes,action_type,template_body) values ($1,0,0,'send_sms','First') returning id", [source]);
  const second = await pg.query<{ id: string }>("insert into public.sequence_steps(sequence_id,step_index,delay_after_previous_minutes,action_type,template_body) values ($1,1,1440,'send_sms','Second') returning id", [source]);
  steps = [first.rows[0].id, second.rows[0].id];
  await pg.query("insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','Other')", [otherSource]);
});
afterEach(async () => { await pg.query("rollback to savepoint detail_test"); await pg.query("release savepoint detail_test"); });

it("preserves the overview and needs-person RPCs, including dead-lead and latest-enrollment triage", async () => {
  const definitions = await Promise.all(preservedFunctions.map(async (signature) => {
    const result = await pg.query<{ definition: string }>("select pg_get_functiondef($1::regprocedure) as definition", [`public.${signature}`]);
    return result.rows[0].definition;
  }));
  expect(definitions).toEqual(originalDefinitions);

  const dead = randomUUID();
  const restarted = randomUUID();
  await pg.query("insert into public.properties(id,org_id,address,state,status) values ($1,$3,'Dead detail lead','MO','dead'),($2,$3,'Restarted detail lead','MO','new_lead')", [dead, restarted, org]);
  await pg.query(`insert into public.sequence_enrollments(id,org_id,sequence_id,property_id,status,enrolled_at)
    values ($1,$5,$6,$3,'completed','2026-09-01T00:00:00Z'),
      ($2,$5,$6,$4,'completed','2026-09-01T00:00:00Z')`,
  [randomUUID(), randomUUID(), dead, restarted, org, source]);
  await pg.query(`insert into public.sequence_enrollments(id,org_id,sequence_id,property_id,status,enrolled_at)
    values ($1,$3,$4,$2,'active','2026-09-02T00:00:00Z')`,
  [randomUUID(), restarted, org, source]);
  await asActor();
  const result = await pg.query("select property_id from public.sequence_needs_person($1) where property_id in ($2,$3)", [org, dead, restarted]);
  expect(result.rows).toEqual([]);
});

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

it("allows an active non-admin member to insert sequence steps directly under existing RLS", async () => {
  await asActor();
  const inserted = await pg.query<{ sequence_id: string; template_body: string }>(
    "insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','Member insert') returning sequence_id,template_body",
    [target],
  );
  expect(inserted.rows).toEqual([{ sequence_id: target, template_body: "Member insert" }]);
});

it("rejects a copy into a cross-org target when the actor is not a target-org member", async () => {
  const foreignTarget = randomUUID();
  await pg.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Foreign target')", [foreignTarget, otherOrg]);
  await rejected("select public.sequence_copy_steps($1,$2)", [foreignTarget, source], "42501");
  expect((await pg.query("select count(*) from public.sequence_steps where sequence_id=$1", [foreignTarget])).rows[0].count).toBe("0");
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
  // #704 still uses run_at here, so the 11:00 reply clears this bucket.
  expect(needsPerson.rows.map((row) => row.property_id)).not.toContain(noReply.property);
  expect(needsPerson.rows.map((row) => row.property_id)).not.toContain(replied.property);
  await pg.query("reset role");
  await rejected("select * from public.sequence_step_stats($1,$2)", [otherOrg, source], "42501");
});
