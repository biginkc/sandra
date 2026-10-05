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
  const finalize = (outcome: string, key: string) => asRep(async () => (await db.query('select public.fn_finalize_acquisition_attempt($1::jsonb) as r', [JSON.stringify({
    orgId: org, propertyId: property, callActivityId: activity, idempotencyKey: key, outcome, occurredAt: '2026-10-08T15:00:00.000Z' })])).rows[0].r as { ok: boolean; duplicate: boolean; attemptId: string });
  // What the prompt does after a committed finalize: the note and the quick next step, each keyed on
  // the opening's own submission id (savePostCallExtras). It runs only when the finalize committed.
  const extras = async (submissionId: string) => {
    await db.query('insert into public.lead_notes(org_id,property_id,author_user_id,body,idempotency_key) values ($1,$2,$3,$4,$5) on conflict do nothing',
      [org, property, rep, 'Seller wants a call Friday', submissionId]);
    // The appointment goes through the service-role booking path (the booking window is a UI rule).
    await db.query("select set_config('request.jwt.claim.role','service_role',true)");
    await db.query('set local role service_role');
    await db.query("select public.fn_create_next_step(p_org := $1, p_actor := $2, p_assignee := $2, p_kind := 'appointment', p_title := 'Callback', p_due_at := now() + interval '1 day', p_property := $3, p_mode := 'phone', p_idempotency_key := $4)",
      [org, rep, property, submissionId]);
    await db.query('reset role');
    await db.query("select set_config('request.jwt.claim.role','',true)");
  };
  const counts = async () => ({
    receipts: (await db.query("select count(*)::int n from public.acquisition_commands where org_id=$1 and operation='finalize_acquisition_attempt'", [org])).rows[0].n as number,
    notes: (await db.query('select count(*)::int n from public.lead_notes where property_id=$1', [property])).rows[0].n as number,
    appointments: (await db.query("select count(*)::int n from public.tasks where related_property_id=$1 and type='appointment'", [property])).rows[0].n as number,
  });
  return { org, rep, property, activity, asRep, finalize, extras, counts };
}

it('refuses a second key for an already-finalized attempt: one receipt, one note, one appointment; same-key replay stays idempotent', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const tabA = randomUUID(), tabB = randomUUID();
    const first = await w.finalize('reached', tabA);
    expect(first.failure).toBeNull();
    expect(first.value).toMatchObject({ ok: true, duplicate: false });
    await w.extras(randomUUID());

    // Tab B: its own key and its own submission id, SAME outcome (the case the old guard accepted).
    const second = await w.finalize('reached', tabB);
    expect(second.failure?.code).toBe('MLS01');
    expect(second.failure?.message).toBe('ALREADY_FINALIZED');
    // The client writes extras only after a committed finalize, so a refused save writes nothing.
    expect(await w.counts()).toEqual({ receipts: 1, notes: 1, appointments: 1 });

    // A different outcome under a different key is refused the same way.
    const third = await w.finalize('no_answer', randomUUID());
    expect(third.failure?.message).toBe('ALREADY_FINALIZED');

    // Tab A retrying with its own key is still a harmless replay.
    const replay = await w.finalize('reached', tabA);
    expect(replay.failure).toBeNull();
    expect(replay.value).toMatchObject({ ok: true, duplicate: true, attemptId: first.value!.attemptId });
    expect(await w.counts()).toEqual({ receipts: 1, notes: 1, appointments: 1 });
  });
});

it('fn_post_call_extras_foreign_finalize: true only for a call finalized under another key', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const tabA = randomUUID(), tabB = randomUUID();
    const foreign = (key: string, activity: string | null = w.activity) => w.asRep(async () => (await db.query(
      'select public.fn_post_call_extras_foreign_finalize($1,$2,$3) as r', [w.org, key, activity])).rows[0].r as boolean);
    // Nothing finalized yet: nobody is foreign.
    expect((await foreign(tabB)).value).toBe(false);
    expect((await w.finalize('reached', tabA)).failure).toBeNull();
    // Tab A finalized: tab B's key is foreign, tab A's own key is not, and another call is untouched.
    expect((await foreign(tabB)).value).toBe(true);
    expect((await foreign(tabA)).value).toBe(false);
    expect((await foreign(tabB, randomUUID())).value).toBe(false);
  });
});

it('shows the old double-write without the guard (rollback), proving the test would catch the bug', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    expect((await w.finalize('reached', randomUUID())).failure).toBeNull();
    // Rolled back: the same-outcome second key is accepted again.
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
