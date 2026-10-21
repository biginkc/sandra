import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const pg = new Client({ connectionString: requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres") });
// The migration wraps itself in begin/commit; run its body inside this test's transaction.
const sql = readFileSync("supabase/migrations/20261021200400_voicemail_drop_rotation.sql", "utf8")
  .replace(/^begin;$/m, "").replace(/^commit;$/m, "");
let actor!: string, org!: string, sequence!: string, first!: string;

async function asActor(user = actor) {
  await pg.query("set local role authenticated");
  await pg.query("select set_config('request.jwt.claim.role','authenticated',true)");
  await pg.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
  await pg.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: user })]);
}
async function asOwner() { await pg.query("reset role"); }
async function sqlError(text: string, params: unknown[] = []) {
  await pg.query("savepoint sql_error");
  try { await pg.query(text, params); return null; }
  catch (error) { return (error as { code?: string }).code ?? "error"; }
  finally { await pg.query("rollback to savepoint sql_error"); }
}
async function replaceError(steps: unknown[]) {
  const result = await pg.query("select pg_temp.capture_replace_error($1,$2::jsonb)", [sequence, JSON.stringify(steps)]);
  return result.rows[0].capture_replace_error as string | null;
}
const sms = (index: number, id?: string) => ({ ...(id ? { id } : {}), step_index: index,
  delay_after_previous_minutes: 0, action_type: "send_sms", template_body: `Text ${index}`, template_id: null, target_status: null });
const rotation = (index: number, extra: Record<string, unknown> = {}) => ({ step_index: index,
  delay_after_previous_minutes: 60, action_type: "send_voicemail_drop",
  vm_template_category: "Group A", vm_voice_id: "voice-1", vm_phone_line_id: "line-1", ...extra });
const INVALID = /Invalid step body, template, status, or delay/;

beforeAll(async () => {
  await pg.connect();
  await pg.query("begin");
  await pg.query(sql);
  await pg.query(`create function pg_temp.capture_replace_error(p_sequence uuid, p_steps jsonb)
    returns text language plpgsql as $$
    begin
      perform public.sequence_replace_steps(p_sequence,p_steps,'Renamed','d');
      return null;
    exception when others then return sqlerrm;
    end $$`);
});
afterAll(async () => { await pg.query("rollback"); await pg.end(); });
beforeEach(async () => {
  await pg.query("savepoint test_case");
  actor = randomUUID(); org = randomUUID(); sequence = randomUUID();
  await pg.query("insert into auth.users(id) values ($1)", [actor]);
  await pg.query("insert into public.organizations(id,name) values ($1,'Rotation test')", [org]);
  await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [actor, org]);
  await pg.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Original')", [sequence, org]);
  first = (await pg.query("insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','Original') returning id", [sequence])).rows[0].id;
});
afterEach(async () => { await pg.query("rollback to savepoint test_case"); });

it("saves and copies a rotation step through the step RPCs", async () => {
  await asActor();
  await pg.query("select public.sequence_replace_steps($1,$2::jsonb,'Renamed','d')", [sequence, JSON.stringify([sms(0, first), rotation(1)])]);
  await asOwner();
  const saved = await pg.query("select step_index, vm_template_category, vm_tts_body, vm_media_id from public.sequence_steps where sequence_id=$1 order by step_index", [sequence]);
  expect(saved.rows).toEqual([
    { step_index: 0, vm_template_category: null, vm_tts_body: null, vm_media_id: null },
    { step_index: 1, vm_template_category: "Group A", vm_tts_body: null, vm_media_id: null },
  ]);
  const target = randomUUID();
  await pg.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Copy')", [target, org]);
  await asActor();
  await pg.query("select public.sequence_copy_steps($1,$2)", [target, sequence]);
  await asOwner();
  const copied = await pg.query("select vm_template_category from public.sequence_steps where sequence_id=$1 order by step_index", [target]);
  expect(copied.rows.map((r) => r.vm_template_category)).toEqual([null, "Group A"]);
});

it.each([
  ["group + script", [rotation(0, { vm_tts_body: "Hi" })]],
  ["group + recording", [rotation(0, { vm_media_id: "m" })]],
  ["group + SMS pool", [rotation(0, { template_category: "SMS pool" })]],
  ["SMS step with a voicemail group", [{ ...sms(0), vm_template_category: "Group A" }]],
])("the RPC rejects %s", async (_label, steps) => {
  await asActor();
  expect(await replaceError(steps)).toMatch(INVALID);
});

it("the table allows exactly one of recording / script / group", async () => {
  const insert = `insert into public.sequence_steps(sequence_id,step_index,action_type,template_body,vm_media_id,vm_tts_body,vm_template_category)
    values ($1,5,$2,$3,$4,$5,$6)`;
  expect(await sqlError(insert, [sequence, "send_voicemail_drop", null, null, null, "Group A"])).toBeNull();
  expect(await sqlError(insert, [sequence, "send_voicemail_drop", null, null, "Hi", "Group A"])).toBe("23514");
  expect(await sqlError(insert, [sequence, "send_voicemail_drop", null, "m", null, "Group A"])).toBe("23514");
  expect(await sqlError(insert, [sequence, "send_voicemail_drop", null, null, null, "  "])).toBe("23514");
  expect(await sqlError(insert, [sequence, "send_sms", "body", null, null, "Group A"])).toBe("23514");
  expect(await sqlError(insert, [sequence, "send_voicemail_drop", null, null, "Hi", null])).toBeNull();
});

it("voicemail_templates: 1,200-char cap, member read/write in own org only, no hard delete", async () => {
  const insert = "insert into public.voicemail_templates(org_id,name,content,category) values ($1,'n',$2,'Group A')";
  expect(await sqlError(insert, [org, "a".repeat(1201)])).toBe("23514");
  expect(await sqlError(insert, [org, "  "])).toBe("23514");
  const outsider = randomUUID(), otherOrg = randomUUID();
  await pg.query("insert into auth.users(id) values ($1)", [outsider]);
  await pg.query("insert into public.organizations(id,name) values ($1,'Other org')", [otherOrg]);
  await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [outsider, otherOrg]);

  await asActor();
  await pg.query(insert, [org, "Script"]);
  expect(await sqlError(insert, [otherOrg, "Script"])).toBe("42501");
  expect((await pg.query("select count(*)::int as n from public.voicemail_templates")).rows[0].n).toBe(1);
  expect(await sqlError("delete from public.voicemail_templates")).toBe("42501");
  await pg.query("update public.voicemail_templates set deleted_at = now()");
  await asOwner();
  await asActor(outsider);
  expect((await pg.query("select count(*)::int as n from public.voicemail_templates")).rows[0].n).toBe(0);
  await asOwner();
});

it("voicemail scripts never land in sms_templates", async () => {
  await pg.query("insert into public.voicemail_templates(org_id,name,content,category) values ($1,'n','Spoken','Group A')", [org]);
  expect((await pg.query("select count(*)::int as n from public.sms_templates where content='Spoken'")).rows[0].n).toBe(0);
});
