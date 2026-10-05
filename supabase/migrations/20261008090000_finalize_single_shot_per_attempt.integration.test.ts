import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

const strip = (file: string) => {
  const sql = readFileSync(new URL(file, import.meta.url), 'utf8');
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error(`${file}: transaction wrapper changed`);
  return sql.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
};
const migration = strip('./20261008090000_finalize_single_shot_per_attempt.sql');
const rollback = strip('../rollbacks/20261008090000_finalize_single_shot_per_attempt.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
// The ACTUAL validator the server action applies to every key (read from its source, not re-typed).
const actionsSource = readFileSync(new URL('../../src/app/(dashboard)/my-leads/actions.ts', import.meta.url), 'utf8');
const regexSource = /const POST_CALL_UUID =\s*\/(.+)\/i;/.exec(actionsSource);
if (!regexSource) throw new Error('POST_CALL_UUID validator not found in actions.ts');
const actionUuid = new RegExp(regexSource[1], 'i');
const RFC4122 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FN = 'public.fn_finalize_acquisition_attempt_without_sms_obligation(jsonb)';

// Every test runs in a rolled-back transaction. The database may or may not already carry the
// migration (CI applies the whole chain), so each test first rolls back and re-applies it: both
// starting states end identically, and a re-apply exercises the anchored patch against the prior body.
async function withDb(fn: (db: Client) => Promise<void>, apply = true) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await db.query(rollback);
    if (apply) await db.query(migration);
    await fn(db);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

async function world(db: Client) {
  const org = randomUUID(), owner = randomUUID(), rep = randomUUID();
  for (const id of [owner, rep]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1,'Second tab')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [owner, org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [rep, org]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
  await db.query("select set_config('my_leads.designation_update',$1,true)", [`${owner}:${org}:${rep}`]);
  await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [rep, org]);
  await db.query("select set_config('my_leads.designation_update','',true)");
  await db.query("select set_config('request.jwt.claim.sub','',true)");
  const property = randomUUID();
  await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,'1 Main','MO','new_lead',$3)", [property, org, rep]);
  const episode = (await db.query('select id from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null', [property])).rows[0].id as string;
  const activity = randomUUID();
  await db.query("insert into public.call_activities(id,org_id,property_id,jitter_attempt_id,jitter_session_id,provider,direction,started_at,outcome,talk_duration_seconds) values ($1,$2,$3,$4,$4,'jitter','outbound',now()-interval '1 hour','voicemail',0)",
    [activity, org, property, randomUUID()]);
  await db.query("set local session_replication_role='replica'");
  await db.query("insert into public.acquisition_attempts(org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,occurred_at,call_activity_id,provider_attempt_key,idempotency_key) values ($1,$2,$3,$4,'call','sandra',now()-interval '1 hour',$5,$6,$7)",
    [org, property, episode, rep, activity, `sandra:${randomUUID()}`, randomUUID()]);
  await db.query("set local session_replication_role='origin'");
  const asRep = async <T>(fn: () => Promise<T>) => {
    await db.query('savepoint s');
    await db.query('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [rep]);
    let failure: { code?: string; message?: string } | null = null;
    let value: T | null = null;
    try { value = await fn(); } catch (error) { failure = error as { code?: string; message?: string }; }
    if (failure) await db.query('rollback to savepoint s'); else await db.query('release savepoint s');
    await db.query('reset role');
    return { failure, value };
  };
  const asUser = async <T>(user: string, fn: () => Promise<T>) => {
    await db.query('savepoint u');
    await db.query('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
    try { return await fn(); } finally { await db.query('release savepoint u'); await db.query('reset role'); }
  };
  const finalize = (outcome: string, key: string) => asRep(async () => (await db.query('select public.fn_finalize_acquisition_attempt($1::jsonb) as r', [JSON.stringify({
    orgId: org, propertyId: property, callActivityId: activity, idempotencyKey: key, outcome, occurredAt: '2026-10-08T15:00:00.000Z' })])).rows[0].r as { ok: boolean; duplicate: boolean; attemptId: string });
  type Proof = { status: 'proven' | 'foreign' | 'pending'; attemptId?: string; noteKey?: string; nextStepKey?: string };
  const proof = async (key: string, over: { activity?: string | null; property?: string; user?: string } = {}) => asUser(over.user ?? rep, async () =>
    (await db.query('select public.fn_post_call_extras_proof($1,$2,$3,$4) as r', [org, over.property ?? property,
      key, over.activity === undefined ? activity : over.activity])).rows[0].r as Proof);
  // What savePostCallExtras does: write ONLY behind a proven answer, with the keys the proof returned
  // (never a client key). Pending and foreign write nothing.
  const writeExtras = async (answer: Proof, text: string, propertyId = property) => {
    if (answer.status !== 'proven') return false;
    // The keys must survive the server action's own validation, or nothing would ever be written.
    expect(answer.noteKey).toMatch(actionUuid);
    expect(answer.nextStepKey).toMatch(actionUuid);
    await db.query('insert into public.lead_notes(org_id,property_id,author_user_id,body,idempotency_key) values ($1,$2,$3,$4,$5) on conflict do nothing',
      [org, propertyId, rep, text, answer.noteKey]);
    await db.query("select set_config('request.jwt.claim.role','service_role',true)");
    await db.query('set local role service_role');
    await db.query("select public.fn_create_next_step(p_org := $1, p_actor := $2, p_assignee := $2, p_kind := 'appointment', p_title := 'Callback', p_due_at := '2030-01-01T15:00:00Z', p_property := $3, p_mode := 'phone', p_idempotency_key := $4)",
      [org, rep, propertyId, answer.nextStepKey]);
    await db.query('reset role');
    await db.query("select set_config('request.jwt.claim.role','',true)");
    return true;
  };
  const counts = async () => ({
    receipts: (await db.query("select count(*)::int n from public.acquisition_commands where org_id=$1 and operation='finalize_acquisition_attempt'", [org])).rows[0].n as number,
    notes: (await db.query('select count(*)::int n from public.lead_notes where org_id=$1', [org])).rows[0].n as number,
    appointments: (await db.query("select count(*)::int n from public.tasks where org_id=$1 and type='appointment'", [org])).rows[0].n as number,
  });
  return { org, rep, owner, property, activity, episode, asRep, asUser, finalize, proof, writeExtras, counts };
}

it('refuses a second key for an already-finalized attempt: one receipt, one note, one appointment; same-key replay stays idempotent (matrix 1, 4)', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const tabA = randomUUID(), tabB = randomUUID();
    const first = await w.finalize('reached', tabA);
    expect(first.failure).toBeNull();
    expect(first.value).toMatchObject({ ok: true, duplicate: false });
    expect(await w.writeExtras(await w.proof(tabA), 'Seller wants a call Friday')).toBe(true);

    const second = await w.finalize('reached', tabB);
    expect(second.failure?.code).toBe('MLS01');
    expect(second.failure?.message).toBe('ALREADY_FINALIZED');
    expect(await w.counts()).toEqual({ receipts: 1, notes: 1, appointments: 1 });

    const third = await w.finalize('no_answer', randomUUID());
    expect(third.failure?.message).toBe('ALREADY_FINALIZED');

    const replay = await w.finalize('reached', tabA);
    expect(replay.failure).toBeNull();
    expect(replay.value).toMatchObject({ ok: true, duplicate: true, attemptId: first.value!.attemptId });
    expect(await w.counts()).toEqual({ receipts: 1, notes: 1, appointments: 1 });
  });
});

it('ASTRA SEQUENCE (matrix 5): B loses its request before commit, reloads and retries; A then saves; B retries again: 1 note, 1 appointment, B cleared', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const tabA = randomUUID(), tabB = randomUUID();
    // B's finalize never reached the database. Its banner Retry asks for proof: nobody has finalized yet.
    const early = await w.proof(tabB);
    expect(early.status).toBe('pending');
    expect(await w.writeExtras(early, 'B text')).toBe(false);
    expect(await w.counts()).toEqual({ receipts: 0, notes: 0, appointments: 0 });
    // A finalizes and writes its extras.
    expect((await w.finalize('reached', tabA)).failure).toBeNull();
    const a = await w.proof(tabA);
    expect(a.status).toBe('proven');
    expect(await w.writeExtras(a, 'A text')).toBe(true);
    // B retries again: another key holds the call, so B's stored extras are dropped, never written.
    const late = await w.proof(tabB);
    expect(late.status).toBe('foreign');
    expect(await w.writeExtras(late, 'B text')).toBe(false);
    expect(await w.counts()).toEqual({ receipts: 1, notes: 1, appointments: 1 });
    expect((await db.query('select body from public.lead_notes where org_id=$1', [w.org])).rows).toEqual([{ body: 'A text' }]);
  });
});

it('matrix 6: B committed but its response was lost; reload + Retry is proven and writes B once; A is then refused', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const tabA = randomUUID(), tabB = randomUUID();
    expect((await w.finalize('reached', tabB)).failure).toBeNull();
    const b = await w.proof(tabB);
    expect(b.status).toBe('proven');
    expect(await w.writeExtras(b, 'B text')).toBe(true);
    expect((await w.finalize('reached', tabA)).failure?.message).toBe('ALREADY_FINALIZED');
    expect((await w.proof(tabA)).status).toBe('foreign');
    expect(await w.counts()).toEqual({ receipts: 1, notes: 1, appointments: 1 });
  });
});

it('matrix 10, 11: two openings, repeated retries and racing writers all derive the same keys: still one note, one appointment', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const tabA = randomUUID();
    expect((await w.finalize('reached', tabA)).failure).toBeNull();
    const first = await w.proof(tabA);
    const second = await w.proof(tabA);
    expect([second.noteKey, second.nextStepKey]).toEqual([first.noteKey, first.nextStepKey]);
    for (const text of ['opening one', 'opening two', 'opening one', 'retry']) await w.writeExtras(await w.proof(tabA), text);
    expect(await w.counts()).toEqual({ receipts: 1, notes: 1, appointments: 1 });
  });
});

it('derived keys are real RFC 4122 UUIDs that pass the server action validator, and the literal example id yields the literal keys', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const tabA = randomUUID();
    expect((await w.finalize('reached', tabA)).failure).toBeNull();
    const answer = await w.proof(tabA);
    expect(answer.status).toBe('proven');
    for (const key of [answer.noteKey!, answer.nextStepKey!]) {
      expect(key).toMatch(actionUuid);
      expect(key).toMatch(RFC4122);
    }
    expect(answer.noteKey).not.toBe(answer.nextStepKey);
    // Written through the same path the action uses: exactly one note and one appointment.
    expect(await w.writeExtras(answer, 'text')).toBe(true);
    expect(await w.counts()).toEqual({ receipts: 1, notes: 1, appointments: 1 });
    // The unit test hard-codes these for the attempt id Astra used.
    const literal = '11111111-1111-4111-8111-111111111111';
    const keys = (await db.query("select public.fn_post_call_derived_uuid($1) n, public.fn_post_call_derived_uuid($2) s",
      [`post_call_note:${literal}`, `post_call_next_step:${literal}`])).rows[0];
    expect(keys).toEqual({ n: '249bbca2-5080-5e49-a611-69fe513eab4f', s: 'fcecf655-7a01-5c38-b419-fc6a43c4a1c2' });
    for (let i = 0; i < 200; i++) {
      const k = (await db.query('select public.fn_post_call_derived_uuid($1) k', [randomUUID()])).rows[0].k as string;
      expect(k).toMatch(RFC4122);
    }
  });
});

it('matrix 12, 13: another rep, or another lead, never gets proof for a key', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const tabA = randomUUID();
    expect((await w.finalize('reached', tabA)).failure).toBeNull();
    // The owner (an active member, not the actor) sends the rep's key.
    expect((await w.proof(tabA, { user: w.owner })).status).toBe('pending');
    // The right rep, a different lead.
    const other = randomUUID();
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,'2 Elm','MO','new_lead',$3)", [other, w.org, w.rep]);
    const wrongLead = await w.proof(tabA, { property: other });
    expect(wrongLead.status).toBe('pending');
    expect(await w.writeExtras(wrongLead, 'x', other)).toBe(false);
    expect(await w.counts()).toEqual({ receipts: 1, notes: 0, appointments: 0 });
  });
});

it('matrix 15: a manual attempt is proven by its own log receipt; a deliberate second log is a second attempt with its own one note and one appointment', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const log = (key: string) => w.asRep(async () => (await db.query('select public.fn_log_acquisition_attempt($1::jsonb) as r', [JSON.stringify({
      propertyId: w.property, idempotencyKey: key, expectedEpisodeId: w.episode, expectedQueueVersion: 0, expectedSharedStatus: 'new_lead',
      occurredAt: new Date(Date.now() - 60_000).toISOString(), source: 'manual', kind: 'outreach', outcome: 'voicemail' })])).rows[0].r as { attemptId: string; queueVersion: number });
    const k1 = randomUUID();
    const one = await log(k1);
    expect(one.failure).toBeNull();
    const p1 = await w.proof(k1, { activity: null });
    expect(p1.status).toBe('proven');
    expect(p1.attemptId).toBe(one.value!.attemptId);
    await w.writeExtras(p1, 'first');
    const k2 = randomUUID();
    const two = await w.asRep(async () => (await db.query('select public.fn_log_acquisition_attempt($1::jsonb) as r', [JSON.stringify({
      propertyId: w.property, idempotencyKey: k2, expectedEpisodeId: w.episode, expectedQueueVersion: one.value!.queueVersion, expectedSharedStatus: 'contacted',
      occurredAt: new Date(Date.now() - 30_000).toISOString(), source: 'manual', kind: 'outreach', outcome: 'voicemail' })])).rows[0].r as { attemptId: string });
    expect(two.failure).toBeNull();
    const p2 = await w.proof(k2, { activity: null });
    expect(p2.status).toBe('proven');
    await w.writeExtras(p2, 'second');
    expect(p2.noteKey).not.toBe(p1.noteKey);
    const c = await w.counts();
    expect(c.notes).toBe(2);
    expect(c.appointments).toBe(2);
  });
});

it('matrix 20: two finalize receipts for one attempt (pre-guard data) are both proven but derive the same keys: still one note, one appointment', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const tabA = randomUUID(), legacy = randomUUID();
    const first = await w.finalize('reached', tabA);
    expect(first.failure).toBeNull();
    await db.query("insert into public.acquisition_commands(org_id,actor_kind,actor_user_id,operation,idempotency_key,request_hash,result) values ($1,'user',$2,'finalize_acquisition_attempt',$3,repeat('a',64),$4)",
      [w.org, w.rep, legacy, JSON.stringify({ ok: true, duplicate: false, propertyId: w.property, attemptId: first.value!.attemptId })]);
    const pa = await w.proof(tabA), pl = await w.proof(legacy);
    expect([pa.status, pl.status]).toEqual(['proven', 'proven']);
    expect(pl.noteKey).toBe(pa.noteKey);
    await w.writeExtras(pa, 'one');
    await w.writeExtras(pl, 'two');
    expect(await w.counts()).toMatchObject({ notes: 1, appointments: 1 });
  });
});

it('matrix 19: the legacy attempt dialog (no extras) is single-shot too: a second key is refused and the attempt keeps one outcome', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    expect((await w.finalize('reached', randomUUID())).failure).toBeNull();
    expect((await w.finalize('reached', randomUUID())).failure?.message).toBe('ALREADY_FINALIZED');
    expect((await db.query('select count(*)::int n from public.acquisition_attempts where org_id=$1', [w.org])).rows[0].n).toBe(1);
  });
});

it('the proof function is not callable by anon and the migration/rollback own it', async () => {
  await withDb(async (db) => {
    const row = (await db.query("select has_function_privilege('anon','public.fn_post_call_extras_proof(uuid,uuid,uuid,uuid)','execute') a, has_function_privilege('authenticated','public.fn_post_call_extras_proof(uuid,uuid,uuid,uuid)','execute') b")).rows[0];
    expect(row).toEqual({ a: false, b: true });
    await db.query(rollback);
    expect((await db.query("select to_regprocedure('public.fn_post_call_extras_proof(uuid,uuid,uuid,uuid)') is not null p")).rows[0].p).toBe(false);
  });
});

it('shows the old double-write without the guard (rollback), proving the test would catch the bug', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    expect((await w.finalize('reached', randomUUID())).failure).toBeNull();
    const second = await w.finalize('reached', randomUUID());
    expect(second.failure).toBeNull();
    expect((await w.counts()).receipts).toBe(2);
    expect((await db.query(`select pg_get_functiondef('${FN}'::regprocedure) d`)).rows[0].d).not.toContain('ALREADY_FINALIZED');
  }, false);
});

it('the anchored patch fails loud when its anchor is missing (already applied)', async () => {
  await withDb(async (db) => {
    await db.query('savepoint again');
    await expect(db.query(migration)).rejects.toThrow(/expected 1 anchor/);
    await db.query('rollback to savepoint again');
  });
});
