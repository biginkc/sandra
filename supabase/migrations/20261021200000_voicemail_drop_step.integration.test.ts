import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const pg = new Client({ connectionString: requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres") });
const sql = readFileSync("supabase/migrations/20261021200000_voicemail_drop_step.sql", "utf8");
let actor!: string, org!: string, sequence!: string, first!: string;

async function asActor(user = actor) {
  await pg.query("set local role authenticated");
  await pg.query("select set_config('request.jwt.claim.role','authenticated',true)");
  await pg.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
  await pg.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: user })]);
}
async function asOwner() { await pg.query("reset role"); }
async function capturedError(steps: unknown[]) {
  const result = await pg.query("select pg_temp.capture_replace_error($1,$2::jsonb)", [sequence, JSON.stringify(steps)]);
  return result.rows[0].capture_replace_error as string | null;
}
async function sqlError(text: string, params: unknown[] = []) {
  await pg.query("savepoint sql_error");
  try { await pg.query(text, params); return null; }
  catch (error) { return (error as { code?: string }).code ?? "error"; }
  finally { await pg.query("rollback to savepoint sql_error"); }
}
const sms = (index: number, id?: string) => ({ ...(id ? { id } : {}), step_index: index,
  delay_after_previous_minutes: 0, action_type: "send_sms", template_body: `Text ${index}`,
  template_id: null, target_status: null });
const drop = (index: number, extra: Record<string, unknown> = {}) => ({ step_index: index,
  delay_after_previous_minutes: 60, action_type: "send_voicemail_drop",
  vm_tts_body: "Hi {first_name}, this is Norma.", vm_voice_id: "voice-1", vm_phone_line_id: "line-1",
  ...extra });
const INVALID = /Invalid step body, template, status, or delay/;

beforeAll(async () => {
  await pg.connect();
  await pg.query("begin");
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
  await pg.query("insert into public.organizations(id,name) values ($1,'Voicemail drop test')", [org]);
  await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [actor, org]);
  await pg.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Original')", [sequence, org]);
  const result = await pg.query("insert into public.sequence_steps(sequence_id,step_index,action_type,template_body) values ($1,0,'send_sms','Original') returning id", [sequence]);
  first = result.rows[0].id;
});
afterEach(async () => { await pg.query("rollback to savepoint test_case"); });

it("saves TTS and media drop steps through sequence_replace_steps", async () => {
  await asActor();
  await pg.query("select public.sequence_replace_steps($1,$2::jsonb,'Renamed','d')", [sequence,
    JSON.stringify([sms(0, first), drop(1), drop(2, { vm_tts_body: null, vm_voice_id: null, vm_media_id: "media-9" })])]);
  const rows = await pg.query(`select step_index, action_type, vm_media_id, vm_tts_body, vm_voice_id, vm_phone_line_id,
    template_body from public.sequence_steps where sequence_id=$1 order by step_index`, [sequence]);
  expect(rows.rows).toMatchObject([
    { step_index: 0, action_type: "send_sms", template_body: "Text 0", vm_tts_body: null },
    { step_index: 1, action_type: "send_voicemail_drop", vm_tts_body: "Hi {first_name}, this is Norma.",
      vm_voice_id: "voice-1", vm_phone_line_id: "line-1", vm_media_id: null, template_body: null },
    { step_index: 2, action_type: "send_voicemail_drop", vm_media_id: "media-9", vm_tts_body: null },
  ]);
});

it.each([
  ["both media and tts", [drop(0, { vm_media_id: "m" })]],
  ["neither media nor tts", [drop(0, { vm_tts_body: "  " })]],
  ["drop with an SMS body", [drop(0, { template_body: "Hello" })]],
  ["drop with a target status", [drop(0, { target_status: "dead" })]],
  ["SMS with a voicemail field", [{ ...sms(0), vm_media_id: "m" }]],
  ["change_status with a voicemail field", [{ step_index: 0, delay_after_previous_minutes: 0,
    action_type: "change_status", target_status: "dead", vm_voice_id: "v" }]],
  ["unknown action type", [{ ...drop(0), action_type: "send_ringless" }]],
])("rejects %s", async (_label, invalid) => {
  await asActor();
  expect(await capturedError(invalid)).toMatch(INVALID);
  const kept = await pg.query("select action_type from public.sequence_steps where sequence_id=$1", [sequence]);
  expect(kept.rows).toEqual([{ action_type: "send_sms" }]);
});

it("copies drop step columns with sequence_copy_steps", async () => {
  const target = randomUUID();
  await pg.query("insert into public.sequences(id,org_id,name) values ($1,$2,'Copy')", [target, org]);
  await pg.query(`insert into public.sequence_steps(sequence_id,step_index,action_type,vm_media_id,vm_phone_line_id)
    values ($1,1,'send_voicemail_drop','media-1','line-2')`, [sequence]);
  await asActor();
  expect((await pg.query("select public.sequence_copy_steps($1,$2) as copied", [target, sequence])).rows[0].copied).toBe(2);
  await asOwner();
  const rows = await pg.query(`select step_index, action_type, template_body, vm_media_id, vm_tts_body, vm_phone_line_id
    from public.sequence_steps where sequence_id=$1 order by step_index`, [target]);
  expect(rows.rows).toEqual([
    { step_index: 0, action_type: "send_sms", template_body: "Original", vm_media_id: null, vm_tts_body: null, vm_phone_line_id: null },
    { step_index: 1, action_type: "send_voicemail_drop", template_body: null, vm_media_id: "media-1", vm_tts_body: null, vm_phone_line_id: "line-2" },
  ]);
});

it("enforces the drop body rule in the table and keeps the SMS rule", async () => {
  const insert = "insert into public.sequence_steps(sequence_id,step_index,action_type,template_body,vm_media_id,vm_tts_body) values ($1,5,$2,$3,$4,$5)";
  expect(await sqlError(insert, [sequence, "send_voicemail_drop", null, null, null])).toBe("23514");
  expect(await sqlError(insert, [sequence, "send_voicemail_drop", null, "m", "tts"])).toBe("23514");
  expect(await sqlError(insert, [sequence, "send_voicemail_drop", null, null, "   "])).toBe("23514");
  expect(await sqlError(insert, [sequence, "send_voicemail_drop", "body", "m", null])).toBe("23514");
  expect(await sqlError(insert, [sequence, "send_sms", null, null, null])).toBe("23514");
  expect(await sqlError(insert, [sequence, "send_sms", "body", "m", null])).toBe("23514");
  expect(await sqlError(insert, [sequence, "send_voicemail_drop", null, null, "Hi"])).toBeNull();
  expect(await sqlError(insert, [sequence, "send_sms", "body", null, null])).toBeNull();
});

it("accepts not_eligible as a skipped_reason and still rejects unknown reasons", async () => {
  const property = randomUUID(), enrollment = randomUUID();
  await pg.query("insert into public.properties(id,org_id,address,state) values ($1,$2,'1 Main','MO')", [property, org]);
  await pg.query("insert into public.sequence_enrollments(id,org_id,sequence_id,property_id) values ($1,$2,$3,$4)", [enrollment, org, sequence, property]);
  const insert = "insert into public.sequence_step_runs(enrollment_id,step_id,scheduled_for,skipped_reason) values ($1,$2,now(),$3)";
  expect(await sqlError(insert, [enrollment, first, "not_eligible"])).toBeNull();
  expect(await sqlError(insert, [enrollment, first, "made_up"])).toBe("23514");
});

it("voicemail_drops: unique step run, checks, member read, no member write, other org hidden", async () => {
  const property = randomUUID(), enrollment = randomUUID();
  await pg.query("insert into public.properties(id,org_id,address,state) values ($1,$2,'1 Main','MO')", [property, org]);
  await pg.query("insert into public.sequence_enrollments(id,org_id,sequence_id,property_id) values ($1,$2,$3,$4)", [enrollment, org, sequence, property]);
  const run = (await pg.query("insert into public.sequence_step_runs(enrollment_id,step_id,scheduled_for) values ($1,$2,now()) returning id", [enrollment, first])).rows[0].id;
  const insert = `insert into public.voicemail_drops(org_id,enrollment_id,step_run_id,idempotency_key,property_id,to_phone,provider,audio_kind,status,attempt_outcome)
    values ($1,$2,$3::uuid,$3::uuid::text,$4,'+15555550100','mock',$5,$6,$7)`;
  expect(await sqlError(insert, [org, enrollment, run, property, "video", "queued", "queued"])).toBe("23514");
  expect(await sqlError(insert, [org, enrollment, run, property, "tts", "sent", "queued"])).toBe("23514");
  expect(await sqlError(insert, [org, enrollment, run, property, "tts", "queued", "accepted"])).toBe("23514");
  await pg.query(insert, [org, enrollment, run, property, "tts", "queued", "queued"]);
  expect(await sqlError(insert, [org, enrollment, run, property, "media", "queued", "queued"])).toBe("23505");

  const outsider = randomUUID(), otherOrg = randomUUID();
  await pg.query("insert into auth.users(id) values ($1)", [outsider]);
  await pg.query("insert into public.organizations(id,name) values ($1,'Other org')", [otherOrg]);
  await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [outsider, otherOrg]);

  await asActor();
  expect((await pg.query("select count(*)::int as n from public.voicemail_drops")).rows[0].n).toBe(1);
  expect(await sqlError("update public.voicemail_drops set status='delivered'")).toBe("42501");
  expect(await sqlError("delete from public.voicemail_drops")).toBe("42501");
  await asOwner();
  await asActor(outsider);
  expect((await pg.query("select count(*)::int as n from public.voicemail_drops")).rows[0].n).toBe(0);
  await asOwner();
});
