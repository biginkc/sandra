import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const pg = new Client({ connectionString: requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres") });
const sql = readFileSync("supabase/migrations/20260929238000_sequence_replace_steps.sql", "utf8");
let actor!: string, org!: string, sequence!: string, first!: string;

async function asActor() {
  await pg.query("set local role authenticated");
  await pg.query("select set_config('request.jwt.claim.role','authenticated',true)");
  await pg.query("select set_config('request.jwt.claim.sub',$1,true)", [actor]);
  await pg.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: actor })]);
}
async function call(steps: unknown[]) {
  return pg.query("select public.sequence_replace_steps($1,$2::jsonb,$3,$4)",
    [sequence, JSON.stringify(steps), "Renamed", "Updated description"]);
}
async function capturedError(steps: unknown[]) {
  const result = await pg.query("select pg_temp.capture_replace_error($1,$2::jsonb)", [sequence, JSON.stringify(steps)]);
  return result.rows[0].capture_replace_error as string | null;
}
const step = (index: number, id?: string) => ({ ...(id ? { id } : {}), step_index: index,
  delay_after_previous_minutes: 0, action_type: "send_sms", template_body: `Text ${index}`,
  template_id: null, target_status: null });

beforeAll(async () => {
  await pg.connect();
  await pg.query("begin");
  // Local reruns can contain an earlier draft of this migration.
  await pg.query("drop function if exists public.sequence_replace_steps(uuid,jsonb,text,text)");
  await pg.query(sql);
  await pg.query(`create function pg_temp.capture_replace_error(p_sequence uuid, p_steps jsonb)
    returns text language plpgsql as $$
    begin
      perform public.sequence_replace_steps(p_sequence,p_steps,'Renamed','Updated description');
      return null;
    exception when others then return sqlerrm;
    end $$`);
});
afterAll(async () => { await pg.query("rollback"); await pg.end(); });
beforeEach(async () => {
  await pg.query("savepoint test_case");
  actor = randomUUID(); org = randomUUID(); sequence = randomUUID();
  await pg.query("insert into auth.users(id) values ($1)", [actor]);
  await pg.query("insert into public.organizations(id,name) values ($1,'Drip editor test')", [org]);
  await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [actor, org]);
  await pg.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Original')", [sequence, org]);
  const result = await pg.query("insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','Original') returning id", [sequence]);
  first = result.rows[0].id;
  await asActor();
});
afterEach(async () => { await pg.query("rollback to savepoint test_case"); });

it("replaces all steps and details atomically while preserving existing IDs", async () => {
  const saved = await call([step(0, first), step(1)]);
  expect(saved.rows[0].sequence_replace_steps).toHaveLength(2);
  expect(saved.rows[0].sequence_replace_steps[0]).toBe(first);
  const rows = await pg.query("select id,step_index,template_body from public.sequence_steps where sequence_id=$1 order by step_index", [sequence]);
  expect(rows.rows).toMatchObject([{ id: first, step_index: 0, template_body: "Text 0" },
    { step_index: 1, template_body: "Text 1" }]);
  expect((await pg.query("select name,description,append_opt_out from public.sequences where id=$1", [sequence])).rows[0])
    .toMatchObject({ name: "Renamed", description: "Updated description", append_opt_out: true });
});

it.each([
  ["both body and template", [{ ...step(0, first), template_id: randomUUID() }], /Invalid step body, template, status, or delay/],
  ["neither body nor template", [{ ...step(0, first), template_body: null }], /Invalid step body, template, status, or delay/],
  ["body and category", [{ ...step(0, first), template_category: "Opener - Homeowner" }], /Invalid step body, template, status, or delay/],
  ["empty category", [{ ...step(0, first), template_body: null, template_category: "  " }], /Invalid step body, template, status, or delay/],
  ["out of order index", [step(1, first)], /Step indexes must be contiguous from zero/],
  ["index gap", [step(0, first), step(2)], /Step indexes must be contiguous from zero/],
])("rejects %s without changing existing data", async (_label, invalid, message) => {
  await pg.query("savepoint invalid_payload");
  expect(await capturedError(invalid)).toMatch(message);
  expect((await pg.query("select name from public.sequences where id=$1", [sequence])).rows[0].name).toBe("Original");
  expect((await pg.query("select template_body from public.sequence_steps where id=$1", [first])).rows[0].template_body).toBe("Original");
  await pg.query("rollback to savepoint invalid_payload");
});

it("rejects an existing step ID from another drip", async () => {
  const otherSequence = randomUUID();
  await pg.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Other drip')", [otherSequence, org]);
  const otherStep = (await pg.query("insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','Other') returning id", [otherSequence])).rows[0].id as string;
  await pg.query("savepoint foreign_step");
  expect(await capturedError([step(0, otherStep)])).toMatch(/does not belong to drip/);
  expect((await pg.query("select name from public.sequences where id=$1", [sequence])).rows[0].name).toBe("Original");
  expect((await pg.query("select sequence_id,template_body from public.sequence_steps where id=$1", [otherStep])).rows[0])
    .toEqual({ sequence_id: otherSequence, template_body: "Other" });
  await pg.query("rollback to savepoint foreign_step");
});

it("round-trips a category-backed step and clears category when replaced by a body", async () => {
  const category = " Opener - Homeowner ";
  await pg.query("set local role postgres");
  await pg.query("update public.sequence_steps set template_body=null, template_category=$2 where id=$1", [first, category]);
  await asActor();
  const categoryStep = { ...step(0, first), template_body: null, template_category: category };
  await call([categoryStep]);
  expect((await pg.query("select template_body,template_id,template_category from public.sequence_steps where id=$1", [first])).rows[0])
    .toEqual({ template_body: null, template_id: null, template_category: category });
  await call([{ ...categoryStep, template_body: "New custom body", template_category: null }]);
  expect((await pg.query("select template_body,template_id,template_category from public.sequence_steps where id=$1", [first])).rows[0])
    .toEqual({ template_body: "New custom body", template_id: null, template_category: null });
});

it("allows a non-admin active member to update steps directly under RLS", async () => {
  await pg.query("set local role postgres");
  actor = randomUUID();
  await pg.query("insert into auth.users(id) values ($1)", [actor]);
  await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [actor, org]);
  await asActor();
  const result = await pg.query("update public.sequence_steps set template_body='Direct member edit' where id=$1 returning template_body", [first]);
  expect(result.rows).toEqual([{ template_body: "Direct member edit" }]);
});

it("reorders existing IDs without colliding with the unique index", async () => {
  const second = (await pg.query("insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,1,'send_sms','Second') returning id", [sequence])).rows[0].id as string;
  const saved = await call([step(0, second), step(1, first)]);
  expect(saved.rows[0].sequence_replace_steps).toEqual([second, first]);
  expect((await pg.query("select id from public.sequence_steps where sequence_id=$1 order by step_index", [sequence])).rows.map((row) => row.id))
    .toEqual([second, first]);
});

it("refuses to delete a step with an execution record", async () => {
  const property = randomUUID();
  await pg.query("set local role postgres");
  await pg.query("insert into public.properties(id,org_id,address,state) values ($1,$2,'History fixture','MO')", [property, org]);
  const enrollment = (await pg.query("insert into public.sequence_enrollments(org_id,sequence_id,property_id,status) values ($1,$2,$3,'completed') returning id", [org, sequence, property])).rows[0].id;
  await pg.query("insert into public.sequence_step_runs(enrollment_id,step_id,scheduled_for) values ($1,$2,now())", [enrollment, first]);
  await asActor();
  await pg.query("savepoint history_delete");
  await expect(call([])).rejects.toThrow(/execution history/);
  await pg.query("rollback to savepoint history_delete");
  expect((await pg.query("select count(*)::integer as n from public.sequence_steps where sequence_id=$1", [sequence])).rows[0].n).toBe(1);
});

it("blocks reorder and deletion for enrolled leads while allowing a text edit and append", async () => {
  const property = randomUUID();
  await pg.query("insert into public.properties(id,org_id,address,state) values ($1,$2,'Active fixture','MO')", [property, org]);
  await pg.query("insert into public.sequence_enrollments(org_id,sequence_id,property_id,status) values ($1,$2,$3,'active')", [org, sequence, property]);
  await pg.query("savepoint remove_enrolled");
  await expect(call([])).rejects.toThrow(/Cannot remove steps/);
  await pg.query("rollback to savepoint remove_enrolled");
  await pg.query("savepoint reorder_enrolled");
  await expect(call([step(0), step(1, first)])).rejects.toThrow(/Cannot reorder steps/);
  await pg.query("rollback to savepoint reorder_enrolled");
  await call([step(0, first), step(1)]);
  expect((await pg.query("select count(*)::integer as n from public.sequence_steps where sequence_id=$1", [sequence])).rows[0].n).toBe(2);
});

it("does not permit a nonmember to edit a drip", async () => {
  actor = randomUUID();
  await asActor();
  await pg.query("savepoint outsider");
  await expect(call([step(0, first)])).rejects.toThrow(/FORBIDDEN/);
  await pg.query("rollback to savepoint outsider");
});
