import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

const sql = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
const migration = sql('./20261009060100_dialpad_outcome_reconciliation.sql');
const rollback = sql('../rollbacks/20261009060100_dialpad_outcome_reconciliation.sql');
const signature = 'public.fn_log_acquisition_attempt_without_sms_obligation(jsonb)';
async function fixture(run: (w: Awaited<ReturnType<typeof world>>) => Promise<void>) {
  const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
  await db.connect();
  try {
    await db.query('begin');
    const def = (await db.query('select pg_get_functiondef($1::regprocedure) as d', [signature])).rows[0].d;
    if (def.includes('AMBIGUOUS_CALL_REFERENCE')) await db.query(rollback);
    // The disposable fixture may predate the deployed second-tab protection.
    const fin = (await db.query("select pg_get_functiondef('public.fn_finalize_acquisition_attempt_without_sms_obligation(jsonb)'::regprocedure) as d")).rows[0].d;
    if (!fin.includes('ALREADY_FINALIZED')) await db.query(sql('./20261008090000_finalize_single_shot_per_attempt.sql'));
    const baseline = (await db.query('select pg_get_functiondef($1::regprocedure) as d', [signature])).rows[0].d;
    const acl = (await db.query('select proacl::text as acl from pg_proc where oid=$1::regprocedure', [signature])).rows[0].acl;
    await db.query(migration);
    expect((await db.query('select proacl::text as acl from pg_proc where oid=$1::regprocedure', [signature])).rows[0].acl).toBe(acl);
    await run(await world(db));
    await db.query(rollback);
    expect((await db.query('select pg_get_functiondef($1::regprocedure) as d', [signature])).rows[0].d).toBe(baseline);
  } finally { await db.query('rollback'); await db.end(); }
}
async function world(db: Client) {
  const org = randomUUID(), owner = randomUUID(), rep = randomUUID(), property = randomUUID();
  for (const id of [owner, rep]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into organizations(id,name) values ($1,$2)", [org, `DialPad reconciliation ${org}`]);
  await db.query("insert into memberships(user_id,org_id,role) values ($1,$2,'owner'),($3,$2,'member')", [owner, org, rep]);
  await db.query('insert into acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('my_leads.designation_update',$2,true)", [owner, `${owner}:${org}:${rep}`]);
  await db.query('update memberships set acquisitions_enabled=true where org_id=$1 and user_id=$2', [org, rep]);
  await db.query("select set_config('my_leads.designation_update','',true)");
  await db.query("insert into properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,'1 Test','MO','contacted',$3)", [property, org, rep]);
  const episode = (await db.query('select id from acquisition_assignment_episodes where property_id=$1 and ended_at is null', [property])).rows[0].id;
  const recording = 'https://dialpad.com/recording/test-call';
  async function automatic(link = recording, actor = rep, lead = property, native = false) {
    const callEpisode = (await db.query('select id from acquisition_assignment_episodes where property_id=$1 and ended_at is null', [lead])).rows[0].id;
    const activity = randomUUID(), attempt = randomUUID(), key = `${native ? 'dialpad-native' : 'dialpad-cti'}:${randomUUID()}`;
    await db.query("insert into call_activities(id,org_id,property_id,jitter_attempt_id,provider,direction,started_at,ended_at,call_purpose,outcome,talk_duration_seconds) values ($1,$2,$3,$4,'dialpad','outbound',now()-interval '1 hour',now()-interval '50 minutes','customer','connected_human',60)", [activity, org, lead, key]);
    await db.query("set local session_replication_role='replica'");
    await db.query("insert into acquisition_attempts(id,org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,occurred_at,call_activity_id,provider_attempt_key,idempotency_key,recording_url) values ($1,$2,$3,$4,$5,'call','dialpad',now()-interval '1 hour',$6,$7,$8,$9)", [attempt, org, lead, callEpisode, actor, activity, key, randomUUID(), link]);
    await db.query("set local session_replication_role='origin'");
    return { activity, attempt };
  }
  const original = await automatic();
  const queue = (await db.query('select version from acquisition_queue_states where property_id=$1', [property])).rows[0];
  const input = { orgId: org, propertyId: property, expectedEpisodeId: episode, expectedQueueVersion: Number(queue?.version ?? 0), expectedSharedStatus: 'contacted', idempotencyKey: randomUUID(), source: 'dialpad', kind: 'call', outcome: 'reached', occurredAt: new Date(Date.now()-60000).toISOString(), recordingUrl: recording };
  async function asRep(query: string, values: unknown[] = []) {
    await db.query('savepoint rep');
    await db.query('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)", [rep]);
    try { const result = await db.query(query, values); await db.query('release savepoint rep'); return result; }
    catch (error) { await db.query('rollback to savepoint rep'); throw error; }
    finally { await db.query('reset role'); }
  }
  const log = async (over = {}) => (await asRep('select fn_log_acquisition_attempt($1::jsonb) as r', [JSON.stringify({ ...input, ...over })])).rows[0].r;
  const counts = async () => (await asRep("select fn_get_acquisition_kpis($1,$2,now()-interval '1 day',now()+interval '1 minute') as r", [org, rep])).rows[0].r;
  const prompts = async () => (await asRep('select fn_list_unacknowledged_call_prompts($1) as r', [org])).rows[0].r.items;
  return { db, org, rep, owner, property, episode, recording, original, automatic, input, log, counts, prompts, asRep };
}

it('resolves the identical recording, clears its prompt, preserves KPI count and replays the log receipt', () => fixture(async w => {
  expect(await w.counts()).toMatchObject({ attempts: 1, reached: 0, pendingOutcomes: 1 });
  expect(await w.prompts()).toHaveLength(1);
  expect(await w.log()).toMatchObject({ ok: true, attemptId: w.original.attempt, duplicate: false });
  expect(await w.log()).toMatchObject({ attemptId: w.original.attempt, duplicate: true });
  expect(await w.counts()).toMatchObject({ attempts: 1, reached: 1, pendingOutcomes: 0 });
  expect(await w.prompts()).toHaveLength(0);
  await expect(w.log({ idempotencyKey: randomUUID() })).rejects.toThrow('ALREADY_FINALIZED');
  await expect(w.log({ outcome: 'wrong_number' })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
}));

it('preserves separate calls and their pending prompts', () => fixture(async w => {
  const other = await w.automatic('https://dialpad.com/recording/other', w.rep, w.property, true);
  await w.log();
  expect(await w.prompts()).toEqual([expect.objectContaining({ attemptId: other.attempt })]);
  const newCall = await w.log({ idempotencyKey: randomUUID(), recordingUrl: 'https://dialpad.com/recording/separate' });
  expect(newCall.attemptId).not.toBe(w.original.attempt);
  expect(await w.counts()).toMatchObject({ attempts: 3, reached: 2, pendingOutcomes: 1 });
}));

it('rejects ambiguous links without writing and allows explicit call finalization', () => fixture(async w => {
  await w.automatic();
  await expect(w.log()).rejects.toThrow('AMBIGUOUS_CALL_REFERENCE');
  expect(await w.counts()).toMatchObject({ attempts: 2, reached: 0, pendingOutcomes: 2 });
  const r = await w.asRep('select fn_finalize_acquisition_attempt($1::jsonb) as r', [JSON.stringify({ ...w.input, callActivityId: w.original.activity })]);
  expect(r.rows[0].r.attemptId).toBe(w.original.attempt);
  expect(await w.prompts()).toHaveLength(1);
}));

it('never matches another caller solely by recording URL', () => fixture(async w => {
  await w.db.query('update acquisition_attempts set recording_url=$1 where id=$2', ['https://dialpad.com/recording/different', w.original.attempt]);
  await w.automatic(w.recording, w.owner);
  const result = await w.log();
  expect(result.attemptId).not.toBe(w.original.attempt);
  expect(await w.counts()).toMatchObject({ attempts: 2, reached: 1, pendingOutcomes: 1 });
}));

it('resolves native DialPad calls and keeps one no-answer obligation on replay', () => fixture(async w => {
  await w.db.query('insert into rep_sms_rollout_enrollments(org_id,user_id,enabled,enrolled_at,enrolled_by) values ($1,$2,true,now(),$3)', [w.org,w.rep,w.owner]);
  await w.db.query("update acquisition_attempts set provider_attempt_key=$1 where id=$2", [`dialpad-native:${randomUUID()}`, w.original.attempt]);
  const first = await w.log({ outcome: 'no_answer', smsBody: 'Can we arrange a time to talk?' });
  expect(first.attemptId).toBe(w.original.attempt);
  expect(first.obligationId).toBeTruthy();
  const replay = await w.log({ outcome: 'no_answer', smsBody: 'Can we arrange a time to talk?' });
  expect(replay).toMatchObject({ duplicate: true, obligationId: first.obligationId });
  expect((await w.db.query('select count(*)::int as n from rep_sms_obligations where attempt_id=$1', [w.original.attempt])).rows[0].n).toBe(1);
  expect(await w.counts()).toMatchObject({ attempts: 1, reached: 0, pendingOutcomes: 0 });
}));

it('does not use another organization as matching evidence', () => fixture(async w => {
  const foreign = await world(w.db);
  await w.db.query('update acquisition_attempts set recording_url=$1 where id=$2', ['https://dialpad.com/recording/different', w.original.attempt]);
  const result = await w.log();
  expect(result.attemptId).not.toBe(foreign.original.attempt);
  expect((await w.db.query('select outcome from acquisition_attempts where id=$1', [foreign.original.attempt])).rows[0].outcome).toBeNull();
  expect(await w.prompts()).toHaveLength(1);
}));

it('locks recording evidence before the property under a concurrent provider update', async () => {
  const connectionString = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!);
  const base = new URL(connectionString);
  const database = `dialpad_race_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  const clients: Client[] = [];
  try {
    // Own database only: fixture rows must be committed for a second connection to see them.
    const template = decodeURIComponent(base.pathname.slice(1)).replaceAll('"', '""');
    await admin.query(`create database "${database}" template "${template}"`);
    base.pathname = `/${database}`;
    const setup = new Client({ connectionString: base.toString() }); clients.push(setup); await setup.connect();
    await setup.query('begin');
    const def = (await setup.query('select pg_get_functiondef($1::regprocedure) as d', [signature])).rows[0].d;
    if (def.includes('AMBIGUOUS_CALL_REFERENCE')) await setup.query(rollback);
    const fin = (await setup.query("select pg_get_functiondef('fn_finalize_acquisition_attempt_without_sms_obligation(jsonb)'::regprocedure) as d")).rows[0].d;
    if (!fin.includes('ALREADY_FINALIZED')) await setup.query(sql('./20261008090000_finalize_single_shot_per_attempt.sql'));
    await setup.query(migration);
    const w = await world(setup);
    await setup.query('commit');
    const provider = new Client({ connectionString: base.toString() }); clients.push(provider); await provider.connect();
    const logging = new Client({ connectionString: base.toString() }); clients.push(logging); await logging.connect();
    const pid = (await logging.query('select pg_backend_pid() as pid')).rows[0].pid;
    await provider.query('begin');
    // Provider projection upserts this attempt before it locks the property.
    await provider.query('select id from acquisition_attempts where id=$1 for update', [w.original.attempt]);
    await logging.query("set statement_timeout='5s'");
    await logging.query('set role authenticated');
    await logging.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)", [w.rep]);
    const saving = logging.query('select fn_log_acquisition_attempt($1::jsonb) as r', [JSON.stringify(w.input)]);
    // Attach rejection handling while waiting on the lock, so test failures never leak promises.
    const settled = saving.then(value => ({ value, error: null }), error => ({ value: null, error }));
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const row = (await setup.query('select wait_event_type from pg_stat_activity where pid=$1', [pid])).rows[0];
      if (row?.wait_event_type === 'Lock') { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(waiting).toBe(true);
    // NOWAIT fails with the original reverse order: log held property while waiting for attempt.
    await provider.query('select id from properties where id=$1 for update nowait', [w.property]);
    await provider.query('commit');
    const result = await settled;
    expect(result.error).toBeNull();
    expect(result.value?.rows[0].r.attemptId).toBe(w.original.attempt);
    expect((await setup.query('select count(*)::int as n from acquisition_attempts where property_id=$1', [w.property])).rows[0].n).toBe(1);
  } finally {
    for (const client of clients) { await client.query('rollback').catch(() => {}); await client.end(); }
    await admin.query(`drop database if exists "${database}"`);
    await admin.end();
  }
});


it('preserves another call on a different lead in the same organization', () => fixture(async w => {
  const otherLead = randomUUID();
  await w.db.query("insert into properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,'2 Test','MO','contacted',$3)", [otherLead,w.org,w.rep]);
  const other = await w.automatic(w.recording,w.rep,otherLead);
  await w.db.query('update acquisition_attempts set recording_url=$1 where id=$2', ['https://dialpad.com/recording/different',w.original.attempt]);
  const result = await w.log();
  expect(result.attemptId).not.toBe(other.attempt);
  expect((await w.db.query('select outcome from acquisition_attempts where id=$1',[other.attempt])).rows[0].outcome).toBeNull();
  await expect(w.asRep('select fn_finalize_acquisition_attempt($1::jsonb)', [JSON.stringify({...w.input,callActivityId:other.activity,idempotencyKey:randomUUID()})])).rejects.toThrow('PROVIDER_EVIDENCE_PENDING');
}));
