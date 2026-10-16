import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

// Local-only, fully migrated disposable database. Each case applies only this
// migration in a rolled-back transaction, retaining the actual current finalize chain.
const strip = (file: string) => {
  const sql = readFileSync(new URL(file, import.meta.url), 'utf8');
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error(`${file}: transaction wrapper changed`);
  return sql.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
};
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

const REP_DIALPAD = '5150000000000001';
const ROOT_CALL = '6543210987654321098';
const SHARE = 'https://dialpad.com/callreview/abc123';
const ADMIN = 'https://dialpad.com/blob/adminrecording/xyz.mp3';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function withDb(fn: (db: Client) => Promise<void>) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    if ((await db.query("select to_regprocedure('public.dialpad_advance_queue_after_outcome(uuid)') as f")).rows[0].f)
      await db.query(strip('../rollbacks/20261009060000_dialpad_projection_preserve_queue_until_outcome.sql'));
    await db.query(strip('./20261009060000_dialpad_projection_preserve_queue_until_outcome.sql'));
    // Match CI's internal-helper ACL even if this local stack has broader default grants.
    await db.query('revoke execute on function public.dialpad_cti_project_intent(uuid) from service_role');
    await fn(db);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

async function as<T>(db: Client, role: 'service_role' | 'authenticated', sub: string | null, run: () => Promise<T>): Promise<T> {
  await db.query(`set local role ${role}`);
  await db.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
  if (sub) await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sub]);
  try { return await run(); } finally { await db.query('reset role').catch(() => {}); }
}
const service = <T,>(db: Client, run: () => Promise<T>) => as(db, 'service_role', null, run);

interface World { db: Client; org: string; other: string; owner: string; rep: string; contact: string; property: string; conn: string; now: number }

async function world(db: Client, training = false): Promise<World> {
  const org = randomUUID(), other = randomUUID(), owner = randomUUID(), rep = randomUUID(), contact = randomUUID(), property = randomUUID();
  for (const id of [owner, rep]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query('insert into public.organizations(id,name) values ($1,$2),($3,$4)', [org, `Links ${org}`, other, `Links ${other}`]);
  await service(db, async () => {
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [owner, org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [rep, org]);
    await db.query("select set_config('my_leads.designation_update', format(':%s:%s', $1::text, $2::text), true)", [org, rep]);
    await db.query('update public.memberships set acquisitions_enabled=true where org_id=$1 and user_id=$2', [org, rep]);
    await db.query("select set_config('my_leads.designation_update', '', true)");
  });
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
  await db.query("insert into public.contacts(id,org_id,first_name,phone_1,phone_1_type) values ($1,$2,'Seller','(816) 555-0142','mobile')", [contact, org]);
  await service(db, () => db.query(
    `insert into public.properties(id,org_id,address,state,homeowner_contact_id,assigned_user_id,is_training,status)
     values ($1,$2,'1 Link Way','MO',$3,$4,$5,'new_lead')`, [property, org, contact, rep, training]));
  const c = await service(db, () => db.query(
    "insert into public.dialpad_org_connections(org_id,status,cti_client_id,webhook_secret_ref) values ($1,'active','client_links','env:DIALPAD_LINKS') returning id", [org]));
  await service(db, async () => {
    const claim = await db.query('select public.fn_claim_dialpad_member_binding($1,$2,$3) as v', [org, rep, REP_DIALPAD]);
    await db.query("select public.fn_verify_dialpad_member_binding($1,'owner_attestation','test-attestation')", [claim.rows[0].v.bindingId]);
  });
  return { db, org, other, owner, rep, contact, property, conn: c.rows[0].id, now: Date.now() };
}

async function prepare(w: World, property = w.property, contact = w.contact): Promise<Json> {
  const r = await service(w.db, () => w.db.query(
    'select public.fn_prepare_dialpad_call_intent($1,$2,$3,$4,1::smallint,$5,null,600) as v', [w.org, w.rep, property, contact, randomUUID()]));
  return r.rows[0].v;
}

interface Ev { callId?: string; state: string; at: number; custom?: string | null; master?: string; extra?: Record<string, unknown>; target?: boolean }
function payload(e: Ev): string {
  const body: Record<string, unknown> = {
    state: e.state, event_timestamp: e.at, external_number: '+18165550142', internal_number: '+18165550100', direction: 'outbound',
    ...(e.target === false ? {} : { target: { type: 'user', id: '__T__' } }),
    ...(e.custom ? { custom_data: e.custom } : {}), ...(e.extra ?? {}),
  };
  let text = JSON.stringify(body).replace('"__T__"', REP_DIALPAD);
  text = text.replace(/^\{/, `{"call_id":${e.callId ?? ROOT_CALL},${e.master ? `"master_call_id":${e.master},` : ''}`);
  return text;
}
async function deliver(w: World, e: Ev): Promise<Json> {
  const ing = await service(w.db, () => w.db.query('select public.fn_ingest_dialpad_call_event($1,$2,1,$3) as v', [w.org, w.conn, payload(e)]));
  const p = await service(w.db, () => w.db.query('select public.fn_process_dialpad_call_event($1) as v', [ing.rows[0].v.eventId]));
  return p.rows[0].v;
}
function call(w: World, custom: string | null, o: { callId?: string; hangup?: Record<string, unknown>; offset?: number } = {}): Ev[] {
  const start = w.now + 1000 + (o.offset ?? 0);
  const common = { callId: o.callId, custom };
  return [
    { ...common, state: 'calling', at: start, extra: { date_started: start } },
    { ...common, state: 'connected', at: start + 4000, extra: { date_started: start, date_connected: start + 4000 } },
    { ...common, state: 'hangup', at: start + 64_000, extra: {
      date_started: start, date_connected: start + 4000, date_ended: start + 64_000, talk_time: 60_000, was_recorded: true,
      public_call_review_share_link: SHARE, admin_recording_urls: [ADMIN], ...(o.hangup ?? {}) } },
  ];
}
async function ledger(w: World) {
  const a = await w.db.query('select * from public.call_activities where org_id=$1 order by created_at,id', [w.org]);
  const t = await w.db.query('select * from public.acquisition_attempts where org_id=$1 order by created_at,id', [w.org]);
  return { activity: a.rows as Json[], attempt: t.rows as Json[] };
}

async function queue(w: World) {
  return (await w.db.query(`select p.status, q.stage, q.version, q.stage_entered_at
    from public.properties p left join public.acquisition_queue_states q on q.property_id=p.id
    where p.id=$1`, [w.property])).rows[0];
}
async function finalize(w: World, activity: string, key = randomUUID()) {
  return as(w.db, 'authenticated', w.rep, () => w.db.query(
    'select public.fn_finalize_acquisition_attempt($1::jsonb) as v', [{ orgId:w.org, propertyId:w.property,
      callActivityId:activity, idempotencyKey:key, outcome:'no_answer', recordingUrl:SHARE }]));
}
describe('Dialpad queue waits for rep outcome', () => {
  it('preserves Not Contacted through calling, connected, hangup and replay; finalize advances once', async () => {
    await withDb(async db => {
      const w = await world(db), intent = await prepare(w);
      const before = await queue(w);
      expect(before.status).toBe('new_lead');
      expect(before.stage).toBeNull();
      for (const e of call(w, String(intent.customData))) {
        await deliver(w, e);
        expect(await queue(w)).toEqual(before);
        const visible = await db.query('select stage from public.my_leads_queue_rows_for($1,$2,statement_timestamp(),$3)', [w.org,w.rep,w.property]);
        expect(visible.rows).toEqual([{stage:'not_contacted'}]);
      }
      const l = await ledger(w);
      expect(l.attempt).toHaveLength(1);
      expect(l.attempt[0].outcome).toBeNull();
      expect(l.activity[0].ended_at).not.toBeNull();
      expect(l.attempt[0].recording_url).toBe(SHARE);
      expect((await db.query('select first_call_started_at from public.acquisition_assignment_episodes where property_id=$1', [w.property])).rows[0].first_call_started_at).not.toBeNull();
      // Replay through the service entrypoint; the projection helper is internal-only.
      for (const e of call(w, String(intent.customData))) await deliver(w, e);
      expect(await queue(w)).toEqual(before);
      const key = randomUUID();
      await finalize(w, l.activity[0].id, key);
      const after = await queue(w);
      expect(after).toMatchObject({status:'contacted', stage:'contacted', version:'1'});
      expect((await ledger(w)).attempt).toHaveLength(1);
      expect((await ledger(w)).attempt[0].outcome).toBe('no_answer');
      await finalize(w, l.activity[0].id, key);
      // Replay through the service entrypoint; the projection helper is internal-only.
      for (const e of call(w, String(intent.customData))) await deliver(w, e);
      expect(await queue(w)).toEqual(after);
    });
  });
  it('preserves an existing advanced queue during provider events and finalize', async () => {
    await withDb(async db => {
      const w = await world(db);
      await db.query("insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at,version) values ($1,$2,'needs_offer',now(),7)", [w.property,w.org]);
      await db.query("update public.properties set status='contacted' where id=$1", [w.property]);
      const before = await queue(w), intent = await prepare(w);
      for (const e of call(w,String(intent.customData))) await deliver(w,e);
      await finalize(w,(await ledger(w)).activity[0].id);
      expect(await queue(w)).toEqual(before);
    });
  });
  it('does not transition a lead reassigned before its original rep logs the outcome', async () => {
    await withDb(async db => {
      const w = await world(db), intent = await prepare(w);
      for (const e of call(w,String(intent.customData))) await deliver(w,e);
      // Put the synthetic call clock in the past before closing its episode.
      await db.query("update public.acquisition_assignment_episodes set assigned_at=statement_timestamp()-interval '2 minutes', first_call_started_at=statement_timestamp()-interval '1 minute' where property_id=$1",[w.property]);
      await service(db, () => db.query('update public.properties set assigned_user_id=$1 where id=$2',[w.owner,w.property]));
      const before = await queue(w);
      await finalize(w,(await ledger(w)).activity[0].id);
      expect(await queue(w)).toEqual(before);
    });
  });
  it('keeps a hangup-first no-answer event in Not Contacted', async () => {
    await withDb(async db => {
      const w = await world(db), intent = await prepare(w), before = await queue(w);
      await deliver(w, {state:'hangup',at:w.now+5000,custom:String(intent.customData),extra:{date_started:w.now+1000,date_ended:w.now+5000,talk_time:0}});
      expect(await queue(w)).toEqual(before);
      const l = await ledger(w);
      expect(l.activity[0].outcome).toBe('no_answer');
      expect(l.attempt[0].outcome).toBeNull();
    });
  });
  it('preserves native Dialpad ledger keys and waits for the native call outcome', async () => {
    await withDb(async db => {
      const w = await world(db), before = await queue(w);
      await db.query('insert into public.my_leads_feature_flags(org_id,native_matcher) values ($1,true) on conflict(org_id) do update set native_matcher=true',[w.org]);
      for (const e of call(w,null)) await deliver(w,e);
      const l = await ledger(w);
      expect(l.attempt).toHaveLength(1);
      expect(l.attempt[0].provider_attempt_key).toBe(`dialpad-native:${ROOT_CALL}`);
      expect(await queue(w)).toEqual(before);
      await finalize(w,l.activity[0].id);
      expect(await queue(w)).toMatchObject({stage:'contacted',status:'contacted'});
    });
  });
  it('leaves queue unchanged when another rep tries to finalize', async () => {
    await withDb(async db => {
      const w = await world(db), intent = await prepare(w), before = await queue(w);
      for (const e of call(w,String(intent.customData))) await deliver(w,e);
      await db.query('savepoint rejected');
      await expect(finalize({...w,rep:w.owner},(await ledger(w)).activity[0].id)).rejects.toThrow();
      await db.query('rollback to savepoint rejected');
      expect(await queue(w)).toEqual(before);
      expect((await ledger(w)).attempt[0].outcome).toBeNull();
    });
  });
  it('preserves archive metadata when an outcome is logged late', async () => {
    await withDb(async db => {
      const w = await world(db), intent = await prepare(w);
      for (const e of call(w,String(intent.customData))) await deliver(w,e);
      await db.query("insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at,version,archived_at,archived_by,archive_reason) values ($1,$2,'contacted',now(),3,now(),$3,'manual')",[w.property,w.org,w.rep]);
      const before = (await db.query('select * from public.acquisition_queue_states where property_id=$1',[w.property])).rows[0];
      await finalize(w,(await ledger(w)).activity[0].id);
      expect((await db.query('select * from public.acquisition_queue_states where property_id=$1',[w.property])).rows[0]).toEqual(before);
      expect((await queue(w)).status).toBe('new_lead');
    });
  });
  it('rolls back and reapplies without changing existing rows', async () => {
    await withDb(async db => {
      const w = await world(db), before = await queue(w);
      await db.query(strip('../rollbacks/20261009060000_dialpad_projection_preserve_queue_until_outcome.sql'));
      expect(await queue(w)).toEqual(before);
      await db.query(strip('./20261009060000_dialpad_projection_preserve_queue_until_outcome.sql'));
      const intent = await prepare(w);
      await deliver(w, call(w,String(intent.customData))[0]!);
      expect(await queue(w)).toEqual(before);
    });
  });
  it('keeps projection and transition helper inaccessible to browser roles', async () => {
    await withDb(async db => {
      for (const role of ['anon','authenticated']) {
        const r = await db.query("select has_function_privilege($1,'public.dialpad_advance_queue_after_outcome(uuid)','execute') as helper, has_function_privilege($1,'public.dialpad_cti_project_intent(uuid)','execute') as project",[role]);
        expect(r.rows[0]).toEqual({helper:false,project:false});
      }
    });
  });
});
