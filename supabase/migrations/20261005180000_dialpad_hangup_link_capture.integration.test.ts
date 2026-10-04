import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';
import { applyMyLeadsChain } from '@tests/integration/my-leads-housekeeping-fixture';

// Local-only: every test runs inside one transaction that is rolled back. It works on an empty
// local database and on an already fully migrated one (CI): applyMyLeadsChain removes whichever
// stacked My Leads migrations are present (rollback twins, newest first) and applies the ones this
// suite needs, so both starting states end identically.
const strip = (file: string) => {
  const sql = readFileSync(new URL(file, import.meta.url), 'utf8');
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error(`${file}: transaction wrapper changed`);
  return sql.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
};
// A stale local database can hold older Dialpad CTI function bodies than the repo (the projection
// suite re-applies these for the same reason); a migrated one (CI) already has them.
const dialpadBase = [
  './20260929034021_dialpad_cti_foundation.sql',
  './20260929120000_dialpad_cti_call_projection.sql',
  './20260930036000_dialpad_training_projection.sql',
].map(strip);
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

const REP_DIALPAD = '5150000000000001';
const ROOT_CALL = '6543210987654321098';
const LEG_CALL = '6543210987654321099';
const SHARE = 'https://dialpad.com/callreview/abc123';
const ADMIN = 'https://dialpad.com/blob/adminrecording/xyz.mp3';
const VM = 'https://dialpad.com/blob/voicemail/v1.mp3';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type PgError = Error & { code?: string };

async function withDb(fn: (db: Client) => Promise<void>) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    const guard = (await db.query("select prosrc from pg_proc where proname='dialpad_cti_guard_event'")).rows[0]?.prosrc ?? '';
    if (!guard.includes('projected_at')) for (const sql of dialpadBase) await db.query(sql);
    await applyMyLeadsChain(db, ['tools', 'reassign', 'outcome', 'schema', 'createFn', 'modeAware', 'relabel', 'offerChain', 'linkCapture']);
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

async function failure(db: Client, run: () => Promise<unknown>): Promise<PgError> {
  await db.query('savepoint expect_failure');
  let error: PgError | undefined;
  try { await run(); } catch (e) { error = e as PgError; }
  await db.query('rollback to savepoint expect_failure');
  await db.query('reset role');
  if (!error) throw new Error('expected the statement to fail');
  return error;
}

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
const LINKS = ['provider_recording_url', 'provider_voicemail_url', 'provider_voicemail_transcript'] as const;
const links = (row: Json) => Object.fromEntries(LINKS.map((k) => [k, row[k]]));
// The state the five stored production calls are in: projected, no links captured.
async function legacyState(w: World) {
  await w.db.query('update public.call_activities set provider_recording_url=null, provider_voicemail_url=null, provider_voicemail_transcript=null where org_id=$1', [w.org]);
  await w.db.query('update public.acquisition_attempts set recording_url=null where org_id=$1', [w.org]);
}
async function run(w: World, op: 'preview' | 'apply', fp: string | null = null, org = w.org): Promise<Json> {
  const r = await service(w.db, () => w.db.query(
    'select public.fn_my_leads_housekeeping_link_backfill($1,$2,$3) as v', [org, op === 'apply', fp]));
  return r.rows[0].v;
}

describe('20261005180000 dialpad hangup link capture', () => {
  it('writes the share link to the attempt and the admin URL to the call activity, once', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const intent = await prepare(w);
      for (const e of call(w, String(intent.customData))) await deliver(w, e);
      const first = await ledger(w);
      expect(first.attempt).toHaveLength(1);
      expect(first.attempt[0].recording_url).toBe(SHARE);
      expect(links(first.activity[0])).toEqual({ provider_recording_url: ADMIN, provider_voicemail_url: null, provider_voicemail_transcript: null });
      // replaying the same events is a no-op; so is re-running the whole projection
      for (const e of call(w, String(intent.customData))) await deliver(w, e);
      await service(db, () => db.query('select public.dialpad_cti_project_intent($1)', [intent.intentId]));
      const again = await ledger(w);
      expect(again.attempt[0]).toEqual(first.attempt[0]);
      expect(again.activity[0]).toEqual(first.activity[0]);
    });
  });

  it('never overwrites a recording link the rep already pasted, nor a captured value on a later hangup', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const intent = await prepare(w);
      const [calling, connected, hangup] = call(w, String(intent.customData));
      await deliver(w, calling!);
      await db.query("update public.acquisition_attempts set recording_url='https://rep.example/pasted' where org_id=$1", [w.org]);
      await deliver(w, connected!);
      await deliver(w, hangup!);
      let l = await ledger(w);
      expect(l.attempt[0].recording_url).toBe('https://rep.example/pasted');
      expect(l.activity[0].provider_recording_url).toBe(ADMIN);
      // a later hangup for the same leg with different links changes nothing already captured
      await deliver(w, { ...hangup!, at: hangup!.at + 5000, extra: { ...hangup!.extra,
        public_call_review_share_link: 'https://dialpad.com/callreview/later', admin_recording_urls: ['https://dialpad.com/blob/adminrecording/later.mp3'] } });
      l = await ledger(w);
      expect(l.attempt[0].recording_url).toBe('https://rep.example/pasted');
      expect(l.activity[0].provider_recording_url).toBe(ADMIN);
      // a blank pasted value does not block capture
      await db.query("update public.acquisition_attempts set recording_url='  ' where org_id=$1", [w.org]);
      await service(db, () => db.query('select public.dialpad_cti_project_intent($1)', [intent.intentId]));
      expect((await ledger(w)).attempt[0].recording_url).toBe('https://dialpad.com/callreview/later');
    });
  });

  it('stores voicemail link and transcript for a voicemail, and no transcript for a connected call', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const vmIntent = await prepare(w);
      const start = w.now + 1000;
      const vmCustom = String(vmIntent.customData);
      await deliver(w, { state: 'calling', at: start, custom: vmCustom, extra: { date_started: start } });
      await deliver(w, { state: 'voicemail', at: start + 20_000, custom: vmCustom, extra: { date_started: start } });
      await deliver(w, { state: 'hangup', at: start + 30_000, custom: vmCustom, extra: {
        date_started: start, date_ended: start + 30_000, talk_time: 0, voicemail_link: VM, transcription_text: 'Hi, call me back about the house.' } });
      const vm = (await ledger(w)).activity[0];
      expect(links(vm)).toEqual({ provider_recording_url: null, provider_voicemail_url: VM, provider_voicemail_transcript: 'Hi, call me back about the house.' });
      expect(vm.outcome).toBe('voicemail');

      const w2 = await world(db);
      const intent = await prepare(w2);
      for (const e of call(w2, String(intent.customData), { hangup: { transcription_text: 'stray words from a live call' } })) await deliver(w2, e);
      expect(links((await ledger(w2)).activity[0])).toEqual({ provider_recording_url: ADMIN, provider_voicemail_url: null, provider_voicemail_transcript: null });
    });
  });

  it('takes each link from the last-ending leg that has one on a transferred call', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const intent = await prepare(w);
      const start = w.now + 1000;
      const custom = String(intent.customData);
      await deliver(w, { state: 'calling', at: start, custom, extra: { date_started: start } });
      await deliver(w, { state: 'connected', at: start + 3000, custom, extra: { date_started: start, date_connected: start + 3000 } });
      await deliver(w, { state: 'hangup', at: start + 33_000, custom, extra: { date_started: start, date_connected: start + 3000, date_ended: start + 33_000,
        talk_time: 30_000, is_transferred: true, public_call_review_share_link: 'https://dialpad.com/callreview/root', admin_recording_urls: [] } });
      let l = await ledger(w);
      expect(l.activity[0].ended_at).toBeNull();
      expect(l.attempt[0].recording_url).toBeNull(); // not over yet, nothing captured
      const leg = { callId: LEG_CALL, master: ROOT_CALL };
      const s2 = start + 34_000;
      await deliver(w, { ...leg, state: 'connected', at: s2 + 2000, extra: { date_started: s2, date_connected: s2 + 2000 } });
      await deliver(w, { ...leg, state: 'hangup', at: s2 + 47_000, extra: { date_started: s2, date_connected: s2 + 2000, date_ended: s2 + 47_000, talk_time: 45_000,
        admin_recording_urls: [ADMIN] } });
      l = await ledger(w);
      expect(l.activity[0].ended_at).not.toBeNull();
      // the last-ending leg has an admin URL but no share link, so the share link comes from the earlier leg that has one
      expect(l.attempt[0].recording_url).toBe('https://dialpad.com/callreview/root');
      expect(l.activity[0].provider_recording_url).toBe(ADMIN);
    });
  });

  it('stores nothing for a training lead and still creates no attempt', async () => {
    await withDb(async (db) => {
      const w = await world(db, true);
      const intent = await prepare(w);
      for (const e of call(w, String(intent.customData))) await deliver(w, e);
      const l = await ledger(w);
      expect(l.attempt).toHaveLength(0);
      expect(l.activity).toHaveLength(1);
      expect(links(l.activity[0])).toEqual({ provider_recording_url: null, provider_voicemail_url: null, provider_voicemail_transcript: null });
    });
  });

  it('stores null for a URL with userinfo or a non-http scheme', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const intent = await prepare(w);
      for (const e of call(w, String(intent.customData), { hangup: {
        public_call_review_share_link: 'https://user:pw@dialpad.com/callreview/x', admin_recording_urls: ['javascript:alert(1)'] } })) await deliver(w, e);
      const l = await ledger(w);
      expect(l.attempt[0].recording_url).toBeNull();
      expect(l.activity[0].provider_recording_url).toBeNull();
      // the table CHECK is the second fence
      expect((await failure(db, () => db.query("update public.call_activities set provider_recording_url='ftp://x/y' where id=$1", [l.activity[0].id]))).code).toBe('23514');
    });
  });

  it('refuses browser roles writing any provider link column, and still allows the service role', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const intent = await prepare(w);
      for (const e of call(w, String(intent.customData))) await deliver(w, e);
      const id = (await ledger(w)).activity[0].id;
      for (const col of LINKS) {
        const err = await failure(db, () => as(db, 'authenticated', w.rep, () => db.query(`update public.call_activities set ${col}='https://x.example/a' where id=$1`, [id])));
        expect(err.message).toContain('PROVIDER_EVIDENCE_READ_ONLY');
      }
      const ins = await failure(db, () => as(db, 'authenticated', w.rep, () => db.query(
        `insert into public.call_activities(org_id,property_id,operator_user_id,started_at,provider,provider_recording_url)
         values ($1,$2,$3,now(),'sandra_softphone','https://x.example/a')`, [w.org, w.property, w.rep])));
      expect(ins.message).toContain('PROVIDER_EVIDENCE_READ_ONLY');
      // unrelated edits by the same role still work, and the seller-speech guard from 20260927 still holds
      await as(db, 'authenticated', w.rep, () => db.query("update public.call_activities set notes='n' where id=$1", [id]).catch(() => undefined));
      const speech = await failure(db, () => as(db, 'authenticated', w.rep, () => db.query('update public.call_activities set seller_speech_seconds_measured=5 where id=$1', [id])));
      expect(speech.message).toContain('PROVIDER_EVIDENCE_READ_ONLY');
      await service(db, () => db.query("update public.call_activities set provider_voicemail_url='https://dialpad.com/v' where id=$1", [id]));
    });
  });

  it('a captured link clears the missing-recording KPI', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const intent = await prepare(w);
      for (const e of call(w, String(intent.customData))) await deliver(w, e);
      const old = "now() - interval '1 hour'";
      await db.query(`update public.call_activities set started_at=${old}, ended_at=${old}, provider_ended_at=${old} where org_id=$1`, [w.org]);
      await db.query(`update public.acquisition_attempts set occurred_at=${old} where org_id=$1`, [w.org]);
      const kpi = async () => (await as(db, 'authenticated', w.rep, () => db.query(
        "select public.fn_get_acquisition_kpis($1,$2,now() - interval '1 day', now() + interval '1 day') as v", [w.org, w.rep]))).rows[0].v;
      expect((await kpi()).missingRecordings).toBe(0);
      await legacyState(w);
      expect((await kpi()).missingRecordings).toBe(1);
      const fp = (await run(w, 'preview')).fingerprint;
      await run(w, 'apply', fp);
      expect((await kpi()).missingRecordings).toBe(0);
    });
  });

  describe('link-backfill run kind', () => {
    async function fiveCalls(w: World) {
      const intents: Json[] = [];
      for (let i = 0; i < 5; i += 1) {
        const property = randomUUID();
        await service(w.db, () => w.db.query(
          "insert into public.properties(id,org_id,address,state,homeowner_contact_id,assigned_user_id,status) values ($1,$2,$3,'MO',$4,$5,'new_lead')",
          [property, w.org, `${i} Backfill Rd`, w.contact, w.rep]));
        const intent = await prepare(w, property);
        intents.push(intent);
        const callId = `65432109876543210${i}${i}`;
        for (const e of call(w, String(intent.customData), { callId, offset: i * 100_000,
          hangup: { public_call_review_share_link: `${SHARE}-${i}`, admin_recording_urls: [`${ADMIN}-${i}`] } })) await deliver(w, e);
      }
      return intents;
    }

    it('previews without writing, applies the 5-row fixture with before-images, and rolls back conflict-safely', async () => {
      await withDb(async (db) => {
        const w = await world(db);
        await fiveCalls(w);
        expect((await ledger(w)).attempt.every((a) => a.recording_url)).toBe(true);
        await legacyState(w);
        const before = await ledger(w);
        const runsBefore = (await db.query('select count(*)::int as n from public.my_leads_housekeeping_runs')).rows[0].n;

        const preview = await run(w, 'preview');
        expect(preview).toMatchObject({ kind: 'link_backfill', candidates: 5, attemptsToFill: 5, recordingUrlsToStore: 5 });
        expect(JSON.stringify(preview)).not.toContain('dialpad.com');
        expect(await ledger(w)).toEqual(before);
        expect((await db.query('select count(*)::int as n from public.my_leads_housekeeping_runs')).rows[0].n).toBe(runsBefore);

        // apply without or with a wrong fingerprint refuses before any write
        expect((await failure(db, () => run(w, 'apply'))).message).toContain('FINGERPRINT_REQUIRED');
        expect((await failure(db, () => run(w, 'apply', 'f'.repeat(64)))).message).toContain('FINGERPRINT_MISMATCH');
        expect(await ledger(w)).toEqual(before);
        // browser roles cannot call it
        expect((await failure(db, () => as(db, 'authenticated', w.rep, () => db.query('select public.fn_my_leads_housekeeping_link_backfill($1)', [w.org])))).code).toBe('42501');

        const applied = await run(w, 'apply', preview.fingerprint);
        expect(applied).toMatchObject({ attemptsFilled: 5, activitiesFilled: 5, skipped: [] });
        const after = await ledger(w);
        expect(after.attempt.map((a) => a.recording_url).sort()).toEqual([0, 1, 2, 3, 4].map((i) => `${SHARE}-${i}`).sort());
        expect(after.activity.map((a) => a.provider_recording_url).sort()).toEqual([0, 1, 2, 3, 4].map((i) => `${ADMIN}-${i}`).sort());
        // nothing else on the call rows moved (outcome, timing, talk time, updated attempt fields)
        const strip2 = (rows: Json[], drop: string[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.includes(k))));
        expect(strip2(after.activity, [...LINKS, 'updated_at'])).toEqual(strip2(before.activity, [...LINKS, 'updated_at']));
        expect(strip2(after.attempt, ['recording_url', 'updated_at'])).toEqual(strip2(before.attempt, ['recording_url', 'updated_at']));
        const run1 = (await db.query("select * from public.my_leads_housekeeping_runs where id=$1", [applied.runId])).rows[0];
        expect(run1).toMatchObject({ org_id: w.org, kind: 'link_backfill', status: 'applied' });
        const imgs = await db.query('select table_name, count(*)::int as n from public.my_leads_housekeeping_before_images where run_id=$1 group by 1 order by 1', [applied.runId]);
        expect(imgs.rows).toEqual([{ table_name: 'acquisition_attempts', n: 5 }, { table_name: 'call_activities', n: 5 }]);
        // a second preview has no candidates, and applying that is a no-op without a run row
        const empty = await run(w, 'preview');
        expect(empty.candidates).toBe(0);
        expect(await run(w, 'apply', empty.fingerprint)).toMatchObject({ noop: true, runId: null });

        // conflict-safe rollback: one attempt link was changed by a rep since the run
        const reps = after.attempt[0];
        await db.query("update public.acquisition_attempts set recording_url='https://rep.example/own' where id=$1", [reps.id]);
        const info = (await service(db, () => db.query('select public.fn_my_leads_housekeeping_run_info($1,$2) as v', [applied.runId, w.org]))).rows[0].v;
        const rolled = (await service(db, () => db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as v',
          [applied.runId, w.org, info.fingerprint]))).rows[0].v;
        expect(rolled.status).toBe('applied');
        expect(rolled.restored).toBe(9);
        expect(rolled.notRestored).toEqual([expect.objectContaining({ attempt: reps.id, reason: 'LINK_CHANGED_SINCE' })]);
        const mid = await ledger(w);
        expect(mid.attempt.find((a) => a.id === reps.id)!.recording_url).toBe('https://rep.example/own');
        expect(mid.attempt.filter((a) => a.id !== reps.id).every((a) => a.recording_url === null)).toBe(true);
        expect(mid.activity.every((a) => a.provider_recording_url === null)).toBe(true);
        // once the rep value is gone, the run rolls back fully and a repeat is a no-op
        await db.query('update public.acquisition_attempts set recording_url=null where id=$1', [reps.id]);
        const info2 = (await service(db, () => db.query('select public.fn_my_leads_housekeeping_run_info($1,$2) as v', [applied.runId, w.org]))).rows[0].v;
        const done = (await service(db, () => db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as v',
          [applied.runId, w.org, info2.fingerprint]))).rows[0].v;
        expect(done).toMatchObject({ status: 'rolled_back', notRestored: [] });
        expect(await ledger(w)).toEqual(before);
      });
    });

    it('a changed cohort makes the preview stale, and another org is never touched', async () => {
      await withDb(async (db) => {
        const w = await world(db);
        await fiveCalls(w);
        await legacyState(w);
        const preview = await run(w, 'preview');
        // a rep pastes a link on one candidate between preview and apply
        const a = (await ledger(w)).attempt[0];
        await db.query("update public.acquisition_attempts set recording_url='https://rep.example/own' where id=$1", [a.id]);
        expect((await failure(db, () => run(w, 'apply', preview.fingerprint))).message).toContain('FINGERPRINT_MISMATCH');
        // the other org has no candidates and a run for it cannot move this org's rows
        expect((await run(w, 'preview', null, w.other)).candidates).toBe(0);
        const fresh = await run(w, 'preview');
        expect(fresh.candidates).toBe(5); // the pasted one still needs its admin URL, the rest need both
        expect(fresh.attemptsToFill).toBe(4);
        const applied = await run(w, 'apply', fresh.fingerprint);
        expect(applied).toMatchObject({ attemptsFilled: 4, activitiesFilled: 5 });
        expect((await ledger(w)).attempt.find((x) => x.id === a.id)!.recording_url).toBe('https://rep.example/own');
        const wrongOrg = await failure(db, () => run(w, 'apply', fresh.fingerprint, w.other));
        expect(wrongOrg.message).toContain('FINGERPRINT_MISMATCH');
      });
    });
  });
});
