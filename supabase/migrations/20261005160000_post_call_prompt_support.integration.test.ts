import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';
import { applyMyLeadsChain } from '@tests/integration/my-leads-housekeeping-fixture';

const strip = (file: string) => {
  const sql = readFileSync(new URL(file, import.meta.url), 'utf8');
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error(`${file}: transaction wrapper changed`);
  return sql.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
};
const rollback = strip('../rollbacks/20261005160000_post_call_prompt_support.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function withDb(fn: (db: Client) => Promise<void>, apply = true) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await applyMyLeadsChain(db, ['tools', 'reassign', 'outcome', 'schema', 'createFn', 'readModel', ...(apply ? ['postCall' as const] : [])]);
    await fn(db);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

async function world(db: Client) {
  const org = randomUUID(), owner = randomUUID(), rep = randomUUID();
  for (const id of [owner, rep]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1,'Post call')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [owner, org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [rep, org]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
  await db.query("select set_config('my_leads.designation_update',$1,true)", [`${owner}:${org}:${rep}`]);
  await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [rep, org]);
  await db.query("select set_config('my_leads.designation_update','',true)");
  await db.query("select set_config('request.jwt.claim.sub','',true)");
  // The rep is enrolled in the no-answer SMS rollout, so a no_answer attempt creates an obligation row.
  await db.query('insert into public.rep_sms_rollout_enrollments(org_id,user_id,enabled,enrolled_at,enrolled_by) values ($1,$2,true,now(),$3)', [org, rep, owner]);
  const property = async (label: string) => {
    const id = randomUUID();
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,$3,'MO','new_lead',$4)", [id, org, `${label} Main`, rep]);
    const episode = (await db.query('select id from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null', [id])).rows[0].id as string;
    return { id, episode };
  };
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
  return { org, owner, rep, property, asRep };
}

it('accepts voicemail on log and finalize, rejects bogus and not_logged, and creates no SMS obligation for voicemail', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const log = (p: { id: string; episode: string }, overrides: Record<string, unknown>, key = randomUUID()) =>
      db.query('select public.fn_log_acquisition_attempt($1::jsonb) as r', [JSON.stringify({
        propertyId: p.id, idempotencyKey: key, expectedEpisodeId: p.episode, expectedQueueVersion: 0, expectedSharedStatus: 'new_lead',
        occurredAt: new Date(Date.now() - 60_000).toISOString(), source: 'manual', kind: 'outreach', outcome: 'voicemail', ...overrides })]);
    const obligations = async (propertyId: string) => (await db.query('select count(*)::int n from public.rep_sms_obligations where property_id=$1', [propertyId])).rows[0].n as number;

    // log: voicemail is accepted and obligation-free; no_answer still creates the obligation.
    const vm = await w.property('vm');
    const vmResult = await w.asRep(() => log(vm, {}));
    expect(vmResult.failure).toBeNull();
    const vmAttempt = (vmResult.value!.rows[0].r as Json).attemptId;
    expect((await db.query('select outcome from public.acquisition_attempts where id=$1', [vmAttempt])).rows[0].outcome).toBe('voicemail');
    // asRep rolls back only on failure, so the rows persist for the counts below.
    expect(await obligations(vm.id)).toBe(0);
    const na = await w.property('na');
    expect((await w.asRep(() => log(na, { outcome: 'no_answer', smsBody: 'Hello there' }))).failure).toBeNull();
    expect(await obligations(na.id)).toBe(1);

    // log: bogus and the system-only not_logged are rejected as invalid input.
    for (const outcome of ['bogus', 'not_logged']) {
      const bad = await w.property(outcome);
      const result = await w.asRep(() => log(bad, { outcome }));
      expect(result.failure?.code).toBe('22023');
    }

    // finalize: a pending Sandra call attempt accepts voicemail (no obligation), rejects the others.
    const fin = await w.property('fin');
    const activity = randomUUID();
    await db.query("insert into public.call_activities(id,org_id,property_id,jitter_attempt_id,jitter_session_id,provider,direction,started_at,outcome,talk_duration_seconds) values ($1,$2,$3,$4,$4,'jitter','outbound',now()-interval '1 hour','voicemail',0)",
      [activity, w.org, fin.id, randomUUID()]);
    await db.query("set local session_replication_role='replica'");
    await db.query("insert into public.acquisition_attempts(org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,occurred_at,call_activity_id,provider_attempt_key,idempotency_key) values ($1,$2,$3,$4,'call','sandra',now()-interval '1 hour',$5,$6,$7)",
      [w.org, fin.id, fin.episode, w.rep, activity, `sandra:${randomUUID()}`, randomUUID()]);
    await db.query("set local session_replication_role='origin'");
    const finalize = (outcome: string, key = randomUUID()) => db.query('select public.fn_finalize_acquisition_attempt($1::jsonb) as r', [JSON.stringify({
      orgId: w.org, propertyId: fin.id, callActivityId: activity, idempotencyKey: key, outcome, occurredAt: new Date().toISOString() })]);
    for (const outcome of ['bogus', 'not_logged']) {
      expect((await w.asRep(() => finalize(outcome))).failure?.code).toBe('22023');
    }
    expect((await w.asRep(() => finalize('voicemail'))).failure).toBeNull();
    expect((await db.query('select outcome from public.acquisition_attempts where property_id=$1', [fin.id])).rows[0].outcome).toBe('voicemail');
    expect(await obligations(fin.id)).toBe(0);

    // The manual DialPad log without a link still raises RECORDING_REQUIRED (rule untouched).
    const dp = await w.property('dp');
    const noLink = await w.asRep(() => log(dp, { source: 'dialpad', kind: 'call', outcome: 'reached' }));
    expect(noLink.failure?.message).toContain('RECORDING_REQUIRED');
    const withLink = await w.asRep(() => log(dp, { source: 'dialpad', kind: 'call', outcome: 'voicemail', recordingUrl: 'https://dialpad.example/r/1' }));
    expect(withLink.failure).toBeNull();
  });
});

it('enforces note idempotency per org: duplicate key rejected, many null keys allowed, other orgs unaffected', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const p = await w.property('note');
    const otherOrg = randomUUID();
    await db.query("insert into public.organizations(id,name) values ($1,'Other')", [otherOrg]);
    const otherProperty = randomUUID();
    await db.query("insert into public.properties(id,org_id,address,state,status) values ($1,$2,'Other Main','MO','new_lead')", [otherProperty, otherOrg]);
    const insert = (org: string, property: string, key: string | null) =>
      db.query('insert into public.lead_notes(org_id,property_id,author_user_id,body,idempotency_key) values ($1,$2,$3,$4,$5)', [org, property, w.rep, 'body', key]);
    const key = randomUUID();
    await insert(w.org, p.id, key);
    await db.query('savepoint dup');
    await expect(insert(w.org, p.id, key)).rejects.toMatchObject({ code: '23505' });
    await db.query('rollback to savepoint dup');
    await insert(w.org, p.id, null);
    await insert(w.org, p.id, null);
    await insert(otherOrg, otherProperty, key);
    const row = (await db.query("select indexdef from pg_indexes where indexname='idx_lead_notes_org_idempotency'")).rows[0];
    expect(row.indexdef).toMatch(/\(org_id, idempotency_key\)\s+WHERE \(idempotency_key IS NOT NULL\)/);
    // An ON CONFLICT upsert must name the partial-index predicate to infer the index.
    await db.query('savepoint conflict');
    const upsert = await db.query(
      'insert into public.lead_notes(org_id,property_id,author_user_id,body,idempotency_key) values ($1,$2,$3,$4,$5) on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing returning id',
      [w.org, p.id, w.rep, 'again', key]);
    expect(upsert.rows).toHaveLength(0);
    await db.query('release savepoint conflict');
    expect((await db.query('select count(*)::int n from public.lead_notes where property_id=$1', [p.id])).rows[0].n).toBe(3);
  });
});

it('returns call outcome, talk seconds and provider in call references, and attempt notes in the detail read model', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const p = await w.property('refs');
    const activity = randomUUID();
    await db.query("insert into public.call_activities(id,org_id,property_id,jitter_attempt_id,jitter_session_id,provider,direction,started_at,outcome,talk_duration_seconds) values ($1,$2,$3,$4,$4,'jitter','outbound',now()-interval '1 hour','connected_human',95)",
      [activity, w.org, p.id, randomUUID()]);
    await db.query("set local session_replication_role='replica'");
    await db.query("insert into public.acquisition_attempts(org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,occurred_at,call_activity_id,provider_attempt_key,idempotency_key,note) values ($1,$2,$3,$4,'call','sandra',now()-interval '1 hour',$5,$6,$7,'pending attempt note')",
      [w.org, p.id, p.episode, w.rep, activity, `sandra:${randomUUID()}`, randomUUID()]);
    await db.query("set local session_replication_role='origin'");
    const refs = await w.asRep(() => db.query('select public.fn_get_acquisition_call_references($1,$2,$3) as r', [w.org, p.id, w.rep]));
    expect(refs.failure).toBeNull();
    expect(refs.value!.rows[0].r).toEqual([expect.objectContaining({ id: activity, callOutcome: 'connected_human', talkSeconds: 95, provider: 'jitter' })]);
    const detail = await db.query("select fact from public.my_leads_detail_rows($1,$2,'attempts')", [w.org, p.id]);
    expect(detail.rows).toHaveLength(1);
    expect(detail.rows[0].fact).toMatchObject({ note: 'pending attempt note', outcome: null });
  });
});

it('rolls back to the prior bodies and drops the index and column', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    await db.query(rollback);
    expect((await db.query("select count(*)::int n from pg_indexes where indexname='idx_lead_notes_org_idempotency'")).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int n from information_schema.columns where table_name='lead_notes' and column_name='idempotency_key'")).rows[0].n).toBe(0);
    const p = await w.property('rb');
    const result = await w.asRep(() => db.query('select public.fn_log_acquisition_attempt($1::jsonb) as r', [JSON.stringify({
      propertyId: p.id, idempotencyKey: randomUUID(), expectedEpisodeId: p.episode, expectedQueueVersion: 0, expectedSharedStatus: 'new_lead',
      occurredAt: new Date(Date.now() - 60_000).toISOString(), source: 'manual', kind: 'outreach', outcome: 'voicemail' })]));
    expect(result.failure?.code).toBe('22023');
    const detail = await db.query("select fact from public.my_leads_detail_rows($1,$2,'attempts')", [w.org, p.id]);
    expect(detail.rows).toHaveLength(0);
  });
});
