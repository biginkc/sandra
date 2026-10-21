import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

// Needs a local stack with all migrations applied (this one included).
// Fixtures are committed (two connections must see them) and removed in afterAll.
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
const a = new Client({ connectionString: url });
const b = new Client({ connectionString: url });
const org = randomUUID();
let enrollment!: string, step!: string;

async function newRun() {
  return (await a.query(
    "insert into public.sequence_step_runs(enrollment_id,step_id,scheduled_for,claim_active) values ($1,$2,now(),false) returning id",
    [enrollment, step])).rows[0].id as string;
}
const reserve = (client: Client, run: string, cap: number) => client.query(
  `select public.reserve_voicemail_drop_with_cap($1,$2,now() - interval '1 hour',$3,$4,null,null,
     '+18165550101','mock','tts','Hi Pat') as id`, [org, cap, enrollment, run]);

beforeAll(async () => {
  await a.connect(); await b.connect();
  const sequence = randomUUID(), property = randomUUID();
  enrollment = randomUUID();
  await a.query("insert into public.organizations(id,name) values ($1,$2)", [org, `Drop cap test ${org}`]);
  await a.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Cap')", [sequence, org]);
  step = (await a.query(
    "insert into public.sequence_steps(sequence_id,step_index,action_type,vm_tts_body) values ($1,0,'send_voicemail_drop','Hi') returning id",
    [sequence])).rows[0].id;
  await a.query("insert into public.properties(id,org_id,address,state) values ($1,$2,'1 Main','MO')", [property, org]);
  await a.query("insert into public.sequence_enrollments(id,org_id,sequence_id,property_id) values ($1,$2,$3,$4)",
    [enrollment, org, sequence, property]);
});
afterAll(async () => {
  for (const t of ["voicemail_drops", "sequence_enrollments", "properties", "sequences"]) {
    await a.query(`delete from public.${t} where org_id=$1`, [org]);
  }
  await a.query("delete from public.organizations where id=$1", [org]);
  await a.end(); await b.end();
});

it("inserts under the cap, returns null at the cap, ignores not_queued rows", async () => {
  const first = await reserve(a, await newRun(), 2);
  expect(first.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  await a.query("update public.voicemail_drops set attempt_outcome='not_queued' where id=$1", [first.rows[0].id]);
  expect((await reserve(a, await newRun(), 2)).rows[0].id).not.toBeNull();
  expect((await reserve(a, await newRun(), 2)).rows[0].id).not.toBeNull();
  const capped = await newRun();
  expect((await reserve(a, capped, 2)).rows[0].id).toBeNull();
  expect((await a.query("select count(*)::int n from public.voicemail_drops where step_run_id=$1", [capped])).rows[0].n).toBe(0);
});

it("two parallel reservations for the last slot: exactly one wins", async () => {
  await a.query("delete from public.voicemail_drops where org_id=$1", [org]);
  const [r1, r2] = [await newRun(), await newRun()];
  await a.query("begin");
  await b.query("begin");
  const fromA = await reserve(a, r1, 1);
  // b blocks on the advisory lock until a commits, then sees a's row.
  const pendingB = reserve(b, r2, 1);
  await new Promise((r) => setTimeout(r, 200));
  await a.query("commit");
  const fromB = await pendingB;
  await b.query("commit");
  expect(fromA.rows[0].id).not.toBeNull();
  expect(fromB.rows[0].id).toBeNull();
  expect((await a.query("select count(*)::int n from public.voicemail_drops where org_id=$1", [org])).rows[0].n).toBe(1);
});

it("is service_role only", async () => {
  const grants = await a.query(`select grantee from information_schema.routine_privileges
    where routine_name='reserve_voicemail_drop_with_cap' and privilege_type='EXECUTE'`);
  const who = grants.rows.map((r) => r.grantee);
  expect(who).toContain("service_role");
  expect(who).not.toContain("authenticated");
  expect(who).not.toContain("anon");
});
