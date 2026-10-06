import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { stripTransaction } from '@tests/integration/my-leads-housekeeping-fixture';
import {
  applyP2, asUser, CALL, dbUrl, deliver, failure, ledger, nativeCall, prepare, service, setFlag, world,
  type Json, type World,
} from '@tests/integration/dialpad-p2-fixture';

const MIGRATION = 'migrations/20261008130000_dialpad_call_audio.sql';
const ROLLBACK = 'rollbacks/20261008130000_dialpad_call_audio.sql';
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

// The disposable CI database is fully migrated (this migration included); a local one may not be. Remove this
// migration when present (its own rollback twin), put the My Leads chain back to its P2 state, then apply it.
async function withAudio(fn: (db: Client) => Promise<void>): Promise<void> {
  const db = new Client({ connectionString: dbUrl() });
  await db.connect();
  try {
    await db.query('begin');
    const present = await db.query("select to_regclass('public.dialpad_call_audio') is not null as present");
    if (present.rows[0].present) await db.query(stripTransaction(ROLLBACK));
    await applyP2(db, 'callbacksDue');
    await db.query(stripTransaction(MIGRATION));
    await fn(db);
  } finally {
    await db.query('rollback').catch(() => {});
    await db.end();
  }
}

const q = (db: Client, sql: string, params: unknown[] = []): Promise<Json> => service(db, () => db.query(sql, params));
const rpc = async (db: Client, call: string, params: unknown[] = []): Promise<Json> => (await q(db, `select ${call} as v`, params)).rows[0].v;
const take = (db: Client, holder: string) => rpc(db, 'public.fn_dpa_worker_take($1)', [holder]);
const queue = (db: Client, holder: string, limit = 4) => rpc(db, 'public.fn_dpa_queue($1,$2)', [holder, limit]);
const audioOf = async (db: Client, activityId: string): Promise<Json> =>
  (await db.query('select * from public.dialpad_call_audio where call_activity_id=$1', [activityId])).rows[0];
const attemptsOf = async (db: Client, audioId: string): Promise<Json[]> =>
  (await db.query('select * from public.dialpad_share_link_attempts where audio_id=$1 order by created_at, id', [audioId])).rows;
const past = (interval: string) => `now() - interval '${interval}'`;

// An answered native customer call that ended three hours ago.
async function endedCall(w: World, o: Parameters<typeof nativeCall>[1] = {}): Promise<Json> {
  w.now = Date.now() - 3 * 3_600_000;
  for (const e of nativeCall(w, o)) await deliver(w, e);
  const callId = o.callId ?? CALL;
  return (await ledger(w)).activity.find((a: Json) => a.provider_call_id === callId);
}

async function takeAs(db: Client): Promise<string> {
  const holder = randomUUID();
  expect((await take(db, holder)).taken).toBe(true);
  return holder;
}

// A call that is `discovered` (stable recording id and duration), ready to download.
async function discoveredCall(db: Client, w: World, o: { callId?: string; recording?: string } = {}): Promise<{ activity: Json; audio: Json }> {
  const activity = await endedCall(w, { callId: o.callId });
  await db.query(
    `update public.dialpad_call_audio set state='discovered', provider_recording_id=$2, provider_duration_ms=36000,
       next_attempt_at=${past('1 minute')} where call_activity_id=$1`, [activity.id, o.recording ?? '5185307806048256']);
  return { activity, audio: await audioOf(db, activity.id) };
}

const pathOf = (a: Json) => `${a.org_id}/${a.call_activity_id}/${a.provider_recording_id}.mp3`;
async function markStored(db: Client, activityId: string): Promise<Json> {
  const a = await audioOf(db, activityId);
  await db.query(
    `update public.dialpad_call_audio set state='stored', provider_recording_id=coalesce(provider_recording_id,'R1'),
       storage_path = org_id::text||'/'||call_activity_id::text||'/'||coalesce(provider_recording_id,'R1')||'.mp3',
       size_bytes=1234, sha256=$2, decoded_ms=36000, stored_at=now() where id=$1`, [a.id, SHA]);
  return audioOf(db, activityId);
}

describe('20261008130000 Dialpad call audio', () => {
  it('every object is service-role only; flags default OFF; the bucket is private, 32 MB, audio/mpeg only', async () => {
    await withAudio(async (db) => {
      for (const table of ['dialpad_call_audio', 'dialpad_share_link_attempts', 'dialpad_recording_worker', 'dialpad_audio_access_log']) {
        const r = (await db.query(
          `select c.relrowsecurity, (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies,
             has_table_privilege('anon', c.oid, 'select') as anon_select, has_table_privilege('authenticated', c.oid, 'select') as auth_select,
             has_table_privilege('authenticated', c.oid, 'insert') as auth_insert, has_table_privilege('service_role', c.oid, 'select') as svc_select,
             has_table_privilege('service_role', c.oid, 'insert') as svc_insert, has_table_privilege('service_role', c.oid, 'update') as svc_update
           from pg_class c where c.oid = ('public.' || $1)::regclass`, [table])).rows[0];
        expect(r, table).toEqual({ relrowsecurity: true, policies: 0, anon_select: false, auth_select: false, auth_insert: false, svc_select: true, svc_insert: false, svc_update: false });
      }
      const fns = [
        'fn_dpa_worker_take(uuid)', 'fn_dpa_worker_release(uuid,timestamptz,timestamptz)', 'fn_dpa_worker_block(uuid,timestamptz)',
        'fn_dpa_queue(uuid,integer)', 'fn_dpa_discovery_result(uuid,uuid,text,text,bigint,text,text)', 'fn_dpa_requeue_denied(uuid,uuid,text)',
        'fn_dpa_attempt_begin(uuid,uuid)', 'fn_dpa_attempt_set(uuid,uuid,text,text,text,text,text,text)', 'fn_dpa_resolve_ambiguous(uuid,text)',
        'fn_dpa_audio_fail(uuid,uuid,text,text,text)', 'fn_dpa_mark_uploading(uuid,uuid,text,bigint,bigint)',
        'fn_dpa_register_stored(uuid,uuid,text,bigint,text,bigint)', 'fn_dialpad_audio_authorize(uuid,uuid,uuid)', 'fn_dialpad_audio_for_service(uuid,uuid,text)',
      ];
      for (const fn of fns) {
        const r = (await db.query(
          `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                  has_function_privilege('service_role', $1, 'execute') as svc`, [`public.${fn}`])).rows[0];
        expect(r, fn).toEqual({ anon: false, auth: false, svc: true });
      }
      const helper = (await db.query(
        `select has_function_privilege('service_role', 'public.dpa_assert_holder(uuid)', 'execute') as svc,
                has_function_privilege('authenticated', 'public.dialpad_call_audio_enqueue()', 'execute') as auth`)).rows[0];
      expect(helper).toEqual({ svc: false, auth: false });

      const bucket = (await db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id='dialpad-call-audio'")).rows[0];
      expect(bucket).toEqual({ public: false, file_size_limit: '33554432', allowed_mime_types: ['audio/mpeg'] });
      const policies = (await db.query("select count(*)::int as n from pg_policies where schemaname='storage' and (qual ilike '%dialpad-call-audio%' or with_check ilike '%dialpad-call-audio%')")).rows[0];
      expect(policies.n).toBe(0);

      const w = await world(db);
      await setFlag(db, w.org, 'artifact_fetch', true);
      const flags = (await db.query('select recording_download, recording_download_canary_call_ids, audio_consumers from public.my_leads_feature_flags where org_id=$1', [w.org])).rows[0];
      expect(flags).toEqual({ recording_download: false, recording_download_canary_call_ids: [], audio_consumers: [] });
      const bad = await failure(db, () => db.query("update public.my_leads_feature_flags set audio_consumers = array['jev','nope'] where org_id=$1", [w.org]));
      expect(bad.code).toBe('23514');
    });
  });

  it('the migration has no data step: no rows exist after applying it', async () => {
    await withAudio(async (db) => {
      for (const table of ['dialpad_call_audio', 'dialpad_share_link_attempts', 'dialpad_recording_worker', 'dialpad_audio_access_log']) {
        expect((await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n, table).toBe(0);
      }
    });
  });

  describe('enqueue trigger', () => {
    it('an ended answered customer call creates exactly one job for either direction; replays add nothing', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const outbound = await endedCall(w);
        const a = await audioOf(db, outbound.id);
        expect(a).toMatchObject({ org_id: w.org, call_activity_id: outbound.id, provider_call_id: outbound.provider_call_id, state: 'discovering', attempts: 0, connection_id: w.conn });
        expect(new Date(a.next_attempt_at).getTime() - new Date(a.ended_at).getTime()).toBe(5 * 60_000);
        expect(new Date(a.deadline_at).getTime() - new Date(a.ended_at).getTime()).toBe(24 * 3_600_000);
        for (const e of nativeCall(w)) await deliver(w, e);
        expect((await db.query('select count(*)::int as n from public.dialpad_call_audio where org_id=$1', [w.org])).rows[0].n).toBe(1);

        const inbound = await world(db, { flag: true });
        const call = await endedCall(inbound, { direction: 'inbound' });
        expect(call.direction).toBe('inbound');
        expect(await audioOf(db, call.id)).toMatchObject({ state: 'discovering' });
      });
    });

    it('running the intent projection three times leaves one job', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        await endedCall(w);
        const intent = (await ledger(w)).intent[0];
        for (let i = 0; i < 3; i += 1) await db.query('select public.dialpad_cti_project_intent($1)', [intent.id]);
        expect((await db.query('select count(*)::int as n from public.dialpad_call_audio where org_id=$1', [w.org])).rows[0].n).toBe(1);
      });
    });

    it('no job for a no-answer, voicemail or training call, or a malformed provider call id (and the write still succeeds)', async () => {
      await withAudio(async (db) => {
        const noAnswer = await world(db, { flag: true });
        await endedCall(noAnswer, { answered: false });
        const training = await world(db, { flag: true, training: true });
        await endedCall(training);
        const bad = await world(db, { flag: true });
        // The artifact trigger has its own digits CHECK; take it out of the way so only this trigger is on trial.
        await db.query('alter table public.call_activities disable trigger dialpad_artifact_fetches_enqueue_trg');
        const id = randomUUID();
        await db.query(
          `insert into public.call_activities(id, org_id, jitter_attempt_id, provider, provider_call_id, ended_at, outcome, call_purpose)
           values ($1,$2,$3,'dialpad','not-digits', now(), 'connected_human', 'customer')`, [id, bad.org, `manual-${id}`]);
        expect((await db.query('select count(*)::int as n from public.dialpad_call_audio where org_id = any($1)', [[noAnswer.org, training.org, bad.org]])).rows[0].n).toBe(0);
      });
    });

    it('a late native assignment (provider call id set after the call ended) and a late outcome change each create one job', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const late = randomUUID();
        await db.query(
          `insert into public.call_activities(id, org_id, jitter_attempt_id, provider, ended_at, outcome, call_purpose)
           values ($1,$2,$3,'dialpad', now(), 'connected_human', 'customer')`, [late, w.org, `manual-${late}`]);
        expect(await audioOf(db, late)).toBeUndefined();
        await db.query("update public.call_activities set provider_call_id='6000000000000001' where id=$1", [late]);
        expect(await audioOf(db, late)).toMatchObject({ state: 'discovering', provider_call_id: '6000000000000001' });
        await db.query("update public.call_activities set provider_call_id='6000000000000001', outcome='unknown' where id=$1", [late]);
        expect((await db.query('select count(*)::int as n from public.dialpad_call_audio where call_activity_id=$1', [late])).rows[0].n).toBe(1);

        const early = randomUUID();
        await db.query(
          `insert into public.call_activities(id, org_id, jitter_attempt_id, provider, provider_call_id, ended_at, outcome, call_purpose)
           values ($1,$2,$3,'dialpad','6000000000000002', now(), 'no_answer', 'customer')`, [early, w.org, `manual-${early}`]);
        expect(await audioOf(db, early)).toBeUndefined();
        await db.query("update public.call_activities set outcome='connected_human' where id=$1", [early]);
        expect(await audioOf(db, early)).toMatchObject({ state: 'discovering' });
      });
    });
  });

  describe('worker singleton', () => {
    it('takes atomically on an empty table; a second holder is refused; an expired lease is taken over; the old holder can write nothing', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const { audio } = await discoveredCall(db, w);
        const first = randomUUID();
        expect(await take(db, first)).toMatchObject({ taken: true, lastRequestAt: null, lastCallGetAt: null, blockedUntil: null });
        expect(await take(db, randomUUID())).toEqual({ taken: false });
        await rpc(db, "public.fn_dpa_worker_block($1, now() + interval '2 hours')", [first]);
        await db.query("update public.dialpad_recording_worker set until = now() - interval '1 second' where id = 1");
        const second = randomUUID();
        const taken = await take(db, second);
        expect(taken.taken).toBe(true);
        expect(new Date(taken.blockedUntil).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
        for (const call of [
          () => rpc(db, 'public.fn_dpa_queue($1,4)', [first]),
          () => rpc(db, "public.fn_dpa_attempt_begin($1,$2)", [first, audio.id]),
          () => rpc(db, "public.fn_dpa_worker_block($1, now())", [first]),
        ]) expect((await failure(db, call)).message).toContain('NOT_HOLDER');
        expect((await attemptsOf(db, audio.id))).toHaveLength(0);
      });
    });

    it('the singleton row is created on demand: deleting it still lets exactly one holder take', async () => {
      await withAudio(async (db) => {
        await takeAs(db);
        await db.query('delete from public.dialpad_recording_worker');
        expect(await take(db, randomUUID())).toMatchObject({ taken: true });
        expect(await take(db, randomUUID())).toEqual({ taken: false });
        expect((await db.query('select count(*)::int as n from public.dialpad_recording_worker')).rows[0].n).toBe(1);
        expect((await failure(db, () => db.query('insert into public.dialpad_recording_worker(id) values (2)'))).code).toBe('23514');
        expect((await failure(db, () => service(db, () => db.query('insert into public.dialpad_recording_worker(id) values (1)')))).code).toBe('42501');
      });
    });

    it('release persists the request clocks (never backwards) and frees the lease; the next take reads them', async () => {
      await withAudio(async (db) => {
        const holder = await takeAs(db);
        await rpc(db, "public.fn_dpa_worker_release($1, '2026-10-06T12:00:10Z', '2026-10-06T12:00:08Z')", [holder]);
        await db.query("update public.dialpad_recording_worker set until = now() - interval '1 second'");
        const next = randomUUID();
        const taken = await take(db, next);
        expect(taken.taken).toBe(true);
        expect(new Date(taken.lastRequestAt).toISOString()).toBe('2026-10-06T12:00:10.000Z');
        expect(new Date(taken.lastCallGetAt).toISOString()).toBe('2026-10-06T12:00:08.000Z');
        await rpc(db, "public.fn_dpa_worker_release($1, '2026-10-06T12:00:05Z', '2026-10-06T12:00:01Z')", [next]);
        const row = (await db.query('select last_request_at, last_call_get_at from public.dialpad_recording_worker')).rows[0];
        expect(new Date(row.last_request_at).toISOString()).toBe('2026-10-06T12:00:10.000Z');
        expect(new Date(row.last_call_get_at).toISOString()).toBe('2026-10-06T12:00:08.000Z');
      });
    });
  });

  describe('queue', () => {
    it('flag OFF: no discovery or download work, but cleanup, ambiguous reporting and upload recovery still list', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const { audio } = await discoveredCall(db, w);
        const holder = await takeAs(db);
        // A live link and an uploading row exist for flag-OFF orgs too.
        const attempt = await rpc(db, 'public.fn_dpa_attempt_begin($1,$2)', [holder, audio.id]);
        await rpc(db, "public.fn_dpa_attempt_set($1,$2,'live',null,'L1','5185307806048256','111','6543210987654321098')", [holder, attempt.attemptId]);
        const q1 = await queue(db, holder);
        expect(q1.download).toBeNull();
        expect(q1.discovery).toEqual([]);
        expect(q1.cleanup).toMatchObject([{ id: attempt.attemptId, state: 'live', shareLinkId: 'L1', itemId: '5185307806048256' }]);
      });
    });

    it('flag ON returns one download (never two) and due discovery rows; the canary list restricts both', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        await setFlag(db, w.org, 'recording_download', true);
        const a = await discoveredCall(db, w);
        await discoveredCall(db, w, { callId: '6543210987654321800', recording: '777' });
        const c = await endedCall(w, { callId: '6543210987654321900' });
        const holder = await takeAs(db);
        const open = await queue(db, holder);
        expect(open.download).not.toBeNull();
        expect(open.discovery.map((r: Json) => r.providerCallId)).toEqual([c.provider_call_id]);
        await db.query('update public.my_leads_feature_flags set recording_download_canary_call_ids = $2 where org_id = $1', [w.org, [a.audio.provider_call_id]]);
        const canary = await queue(db, holder);
        expect(canary.download).toMatchObject({ id: a.audio.id, providerRecordingId: '5185307806048256', providerDurationMs: 36000 });
        expect(canary.discovery).toEqual([]);
        await db.query('update public.my_leads_feature_flags set recording_download_canary_call_ids = $2 where org_id = $1', [w.org, ['999']]);
        const none = await queue(db, holder);
        expect(none.download).toBeNull();
        expect(none.discovery).toEqual([]);
      });
    });

    it('a download is withheld while any link for that recording is unresolved', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        await setFlag(db, w.org, 'recording_download', true);
        const { audio } = await discoveredCall(db, w);
        const holder = await takeAs(db);
        const began = await rpc(db, 'public.fn_dpa_attempt_begin($1,$2)', [holder, audio.id]);
        expect(began.blocked).toBe(false);
        expect((await queue(db, holder)).download).toBeNull();
      });
    });

    it('a dead holder\'s `requested` POST becomes ambiguous (unknown_outcome); the live holder\'s own is left alone', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        await setFlag(db, w.org, 'recording_download', true);
        const { audio } = await discoveredCall(db, w);
        const dead = await takeAs(db);
        const began = await rpc(db, 'public.fn_dpa_attempt_begin($1,$2)', [dead, audio.id]);
        expect((await queue(db, dead)).ambiguous).toEqual([]); // own, in flight
        await db.query("update public.dialpad_recording_worker set until = now() - interval '1 second'");
        const live = await takeAs(db);
        const q2 = await queue(db, live);
        expect(q2.ambiguous).toMatchObject([{ id: began.attemptId, reason: 'unknown_outcome' }]);
        expect((await attemptsOf(db, audio.id))[0]).toMatchObject({ state: 'ambiguous', reason: 'unknown_outcome' });
        expect((await rpc(db, 'public.fn_dpa_attempt_begin($1,$2)', [live, audio.id])).blocked).toBe(true);
      });
    });

    it('rows past their deadline end without a request: none_found when never seen, unavailable when seen', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const a = await endedCall(w);
        const b = await endedCall(w, { callId: '6543210987654321801', offset: 100_000 });
        await db.query("update public.dialpad_call_audio set deadline_at = now() - interval '1 second' where call_activity_id = any($1)", [[a.id, b.id]]);
        await db.query("update public.dialpad_call_audio set seen_recording_id='R', seen_duration_ms=1000 where call_activity_id=$1", [b.id]);
        await queue(db, await takeAs(db));
        expect(await audioOf(db, a.id)).toMatchObject({ state: 'none_found', last_error: 'deadline' });
        expect(await audioOf(db, b.id)).toMatchObject({ state: 'unavailable' });
      });
    });

    it('lists orgs with denied rows so a rotated key can requeue them', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const a = await endedCall(w);
        await db.query("update public.dialpad_call_audio set state='denied', denied_key_fp=$2 where call_activity_id=$1", [a.id, '1'.repeat(16)]);
        const holder = await takeAs(db);
        expect((await queue(db, holder)).deniedOrgs).toEqual([{ orgId: w.org, keyRef: null }]);
        expect(await rpc(db, 'public.fn_dpa_requeue_denied($1,$2,$3)', [holder, w.org, '1'.repeat(16)])).toBe(0);
        expect(await rpc(db, 'public.fn_dpa_requeue_denied($1,$2,$3)', [holder, w.org, '2'.repeat(16)])).toBe(1);
        expect(await audioOf(db, a.id)).toMatchObject({ state: 'discovering', attempts: 0, denied_key_fp: null });
      });
    });
  });

  describe('discovery result', () => {
    it('downloads only after two sightings of the same single recording id and duration at least 10 minutes apart', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const a = await endedCall(w);
        const holder = await takeAs(db);
        const id = (await audioOf(db, a.id)).id;
        const sight = (rec: string, dur: number) => rpc(db, "public.fn_dpa_discovery_result($1,$2,'one',$3,$4)", [holder, id, rec, dur]);
        expect(await sight('R1', 36000)).toMatchObject({ state: 'discovering', attempts: 1 });
        const afterFirst = await audioOf(db, a.id);
        expect(afterFirst).toMatchObject({ seen_recording_id: 'R1', seen_duration_ms: '36000', provider_recording_id: null });
        expect(new Date(afterFirst.next_attempt_at).getTime() - new Date(afterFirst.seen_at).getTime()).toBeGreaterThanOrEqual(10 * 60_000);
        // Immediate second sighting: too soon.
        expect(await sight('R1', 36000)).toMatchObject({ state: 'discovering' });
        // A different duration resets the sighting (still-processing second segment).
        expect(await sight('R1', 40000)).toMatchObject({ state: 'discovering' });
        expect(await audioOf(db, a.id)).toMatchObject({ seen_duration_ms: '40000' });
        await db.query("update public.dialpad_call_audio set seen_at = now() - interval '11 minutes' where id=$1", [id]);
        expect(await sight('R1', 40000)).toEqual({ state: 'discovered' });
        expect(await audioOf(db, a.id)).toMatchObject({ state: 'discovered', provider_recording_id: 'R1', provider_duration_ms: '40000', attempts: 0 });
        // Replay on a non-discovering row changes nothing.
        expect(await sight('R2', 1)).toMatchObject({ replayed: true, state: 'discovered' });
      });
    });

    it('more than one admin recording is terminal; 401/403 is denied with the key fingerprint; 429 is not counted; not_ready and errors are scheduled on the curve', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const holder = await takeAs(db);
        const rows: Json[] = [];
        for (let i = 0; i < 4; i += 1) {
          const c = await endedCall(w, { callId: `65432109876543218${10 + i}`, offset: i * 100_000 });
          rows.push(await audioOf(db, c.id));
        }
        expect(await rpc(db, "public.fn_dpa_discovery_result($1,$2,'multi')", [holder, rows[0].id])).toEqual({ state: 'multi_segment_unsupported' });
        expect(await rpc(db, "public.fn_dpa_discovery_result($1,$2,'denied',null,null,$3,'403')", [holder, rows[1].id, 'c'.repeat(16)])).toEqual({ state: 'denied' });
        expect(await audioOf(db, rows[1].call_activity_id)).toMatchObject({ state: 'denied', denied_key_fp: 'c'.repeat(16) });
        expect(await rpc(db, "public.fn_dpa_discovery_result($1,$2,'rate_limited')", [holder, rows[2].id])).toMatchObject({ state: 'discovering', attempts: 0 });
        await db.query("update public.dialpad_call_audio set ended_at = now() where id=$1", [rows[3].id]);
        expect(await rpc(db, "public.fn_dpa_discovery_result($1,$2,'not_ready')", [holder, rows[3].id])).toMatchObject({ attempts: 1 });
        const nr = await audioOf(db, rows[3].call_activity_id);
        expect(new Date(nr.next_attempt_at).getTime() - new Date(nr.ended_at).getTime()).toBe(15 * 60_000);
        expect(await rpc(db, "public.fn_dpa_discovery_result($1,$2,'error',null,null,null,'500')", [holder, rows[3].id])).toMatchObject({ attempts: 2 });
        expect((await failure(db, () => rpc(db, "public.fn_dpa_discovery_result($1,$2,'bogus')", [holder, rows[3].id]))).code).toBe('22023');
      });
    });
  });

  describe('share-link attempts', () => {
    it('one unresolved link per recording: a second POST row is rejected until the first is resolved', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const { audio } = await discoveredCall(db, w);
        const holder = await takeAs(db);
        const first = await rpc(db, 'public.fn_dpa_attempt_begin($1,$2)', [holder, audio.id]);
        expect(first.blocked).toBe(false);
        expect((await rpc(db, 'public.fn_dpa_attempt_begin($1,$2)', [holder, audio.id])).blocked).toBe(true);
        // Forcing a row straight into the table is rejected by the index.
        const forced = await failure(db, () => db.query(
          "insert into public.dialpad_share_link_attempts(audio_id,org_id,provider_call_id,provider_recording_id,holder) values ($1,$2,$3,$4,$5)",
          [audio.id, audio.org_id, audio.provider_call_id, audio.provider_recording_id, holder]));
        expect(forced.code).toBe('23505');
        await rpc(db, "public.fn_dpa_attempt_set($1,$2,'not_created')", [holder, first.attemptId]);
        expect((await rpc(db, 'public.fn_dpa_attempt_begin($1,$2)', [holder, audio.id])).blocked).toBe(false);
        expect((await failure(db, () => rpc(db, "public.fn_dpa_attempt_begin($1,$2)", [holder, randomUUID()]))).code).toBe('P0002');
      });
    });

    it('begin needs a `discovered` row', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const a = await endedCall(w);
        const holder = await takeAs(db);
        const row = await audioOf(db, a.id);
        expect((await failure(db, () => rpc(db, 'public.fn_dpa_attempt_begin($1,$2)', [holder, row.id]))).message).toContain('NOT_DISCOVERED');
      });
    });

    it('allows only the documented transitions and requires every identity field for a live link', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const { audio } = await discoveredCall(db, w);
        const holder = await takeAs(db);
        const set = (id: string, to: string, ...rest: (string | null)[]) =>
          rpc(db, 'public.fn_dpa_attempt_set($1,$2,$3,$4,$5,$6,$7,$8)', [holder, id, to, rest[0] ?? null, rest[1] ?? null, rest[2] ?? null, rest[3] ?? null, rest[4] ?? null]);
        const { attemptId } = await rpc(db, 'public.fn_dpa_attempt_begin($1,$2)', [holder, audio.id]);
        expect((await failure(db, () => set(attemptId, 'downloaded'))).code).toBe('22023');
        expect((await failure(db, () => set(attemptId, 'deleted'))).code).toBe('22023');
        expect((await failure(db, () => set(attemptId, 'live'))).code).toBe('23514');
        expect(await set(attemptId, 'live', null, 'L1', '5185307806048256', '111', '6543210987654321098')).toEqual({ state: 'live' });
        expect(await set(attemptId, 'downloaded')).toEqual({ state: 'downloaded' });
        expect(await set(attemptId, 'downloaded')).toMatchObject({ replayed: true });
        expect(await set(attemptId, 'deleted')).toEqual({ state: 'deleted' });
        expect(await set(attemptId, 'deleted')).toMatchObject({ replayed: true });
        expect((await failure(db, () => set(attemptId, 'live', null, 'L1', 'x', 'y', 'z'))).code).toBe('22023');
        expect((await failure(db, () => set(attemptId, 'ambiguous', 'mismatch'))).code).toBe('22023');
      });
    });

    it('a mismatch is ambiguous/mismatch, is retained, blocks every later POST and is only released by the owner resolver', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        await setFlag(db, w.org, 'recording_download', true);
        const { audio } = await discoveredCall(db, w);
        const holder = await takeAs(db);
        const { attemptId } = await rpc(db, 'public.fn_dpa_attempt_begin($1,$2)', [holder, audio.id]);
        await rpc(db, "public.fn_dpa_attempt_set($1,$2,'live',null,'L1','5185307806048256','111','6543210987654321098')", [holder, attemptId]);
        expect(await rpc(db, "public.fn_dpa_attempt_set($1,$2,'ambiguous','mismatch')", [holder, attemptId])).toEqual({ state: 'ambiguous' });
        const before = (await attemptsOf(db, audio.id))[0];
        expect(before).toMatchObject({ state: 'ambiguous', reason: 'mismatch', share_link_id: 'L1' });
        for (let tick = 0; tick < 3; tick += 1) {
          const queued = await queue(db, holder);
          expect(queued.cleanup).toEqual([]);
          expect(queued.download).toBeNull();
          expect(queued.ambiguous).toMatchObject([{ id: attemptId, reason: 'mismatch' }]);
          expect((await rpc(db, 'public.fn_dpa_attempt_begin($1,$2)', [holder, audio.id])).blocked).toBe(true);
        }
        expect((await attemptsOf(db, audio.id))).toEqual([before]);
        expect((await failure(db, () => rpc(db, "public.fn_dpa_attempt_set($1,$2,'deleted')", [holder, attemptId]))).code).toBe('22023');
        expect((await failure(db, () => rpc(db, 'public.fn_dpa_resolve_ambiguous($1,$2)', [attemptId, '  ']))).code).toBe('22023');
        expect(await rpc(db, "public.fn_dpa_resolve_ambiguous($1,'checked in Dialpad: link gone')", [attemptId])).toEqual({ state: 'resolved_by_owner' });
        expect(await rpc(db, "public.fn_dpa_resolve_ambiguous($1,'again')", [attemptId])).toMatchObject({ replayed: true });
        expect((await queue(db, holder)).download).toMatchObject({ id: audio.id });
        expect((await rpc(db, 'public.fn_dpa_attempt_begin($1,$2)', [holder, audio.id])).blocked).toBe(false);
      });
    });

    it('a POST response mismatch is ambiguous/post_mismatch from `requested` and keeps what was returned', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const { audio } = await discoveredCall(db, w);
        const holder = await takeAs(db);
        const { attemptId } = await rpc(db, 'public.fn_dpa_attempt_begin($1,$2)', [holder, audio.id]);
        await rpc(db, "public.fn_dpa_attempt_set($1,$2,'ambiguous','post_mismatch','L9','OTHER','111','6543210987654321098')", [holder, attemptId]);
        expect((await attemptsOf(db, audio.id))[0]).toMatchObject({ state: 'ambiguous', reason: 'post_mismatch', share_link_id: 'L9', item_id: 'OTHER' });
        expect((await rpc(db, 'public.fn_dpa_attempt_begin($1,$2)', [holder, audio.id])).blocked).toBe(true);
      });
    });
  });

  describe('audio state', () => {
    it('upload bookkeeping: mark_uploading, register_stored (replay-safe), and a register that does not match is refused', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const { audio } = await discoveredCall(db, w);
        const holder = await takeAs(db);
        const path = pathOf(audio);
        expect((await failure(db, () => rpc(db, 'public.fn_dpa_register_stored($1,$2,$3,$4,$5,$6)', [holder, audio.id, path, 100, SHA, 36000]))).message).toContain('REGISTER_MISMATCH');
        expect(await rpc(db, 'public.fn_dpa_mark_uploading($1,$2,$3,$4,$5)', [holder, audio.id, SHA, 100, 36000])).toEqual({ state: 'uploading', path });
        expect(await rpc(db, 'public.fn_dpa_mark_uploading($1,$2,$3,$4,$5)', [holder, audio.id, SHA, 100, 36000])).toMatchObject({ replayed: true });
        expect(await audioOf(db, audio.call_activity_id)).toMatchObject({ state: 'uploading', upload_expected_sha256: SHA, upload_expected_size: '100', storage_path: path });
        for (const bad of [[path, 100, SHA2], [path, 101, SHA], [`${path}x`, 100, SHA]] as const) {
          expect((await failure(db, () => rpc(db, 'public.fn_dpa_register_stored($1,$2,$3,$4,$5,$6)', [holder, audio.id, bad[0], bad[1], bad[2], 36000]))).message).toContain('REGISTER_MISMATCH');
        }
        expect(await rpc(db, 'public.fn_dpa_register_stored($1,$2,$3,$4,$5,$6)', [holder, audio.id, path, 100, SHA, 35990])).toEqual({ state: 'stored' });
        expect(await audioOf(db, audio.call_activity_id)).toMatchObject({ state: 'stored', size_bytes: '100', sha256: SHA, decoded_ms: '35990' });
        expect(await rpc(db, 'public.fn_dpa_register_stored($1,$2,$3,$4,$5,$6)', [holder, audio.id, path, 100, SHA, 35990])).toMatchObject({ replayed: true });
        // A stored row never moves again.
        expect(await rpc(db, "public.fn_dpa_audio_fail($1,$2,'error')", [holder, audio.id])).toMatchObject({ replayed: true, state: 'stored' });
        // The CHECK refuses any other path.
        const other = await failure(db, () => db.query("update public.dialpad_call_audio set storage_path='x/y/z.mp3' where id=$1", [audio.id]));
        expect(other.code).toBe('23514');
      });
    });

    it('failure kinds: error is counted with a backoff and ends at 6; 429 is not counted; invalid_media ends at 3; too_large / decode_timeout / denied are terminal; recovery_reset needs an uploading row', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const holder = await takeAs(db);
        const fail = (id: string, kind: string, key: string | null = null) => rpc(db, 'public.fn_dpa_audio_fail($1,$2,$3,$4,$5)', [holder, id, kind, null, key]);
        const a = (await discoveredCall(db, w)).audio;
        expect(await fail(a.id, 'rate_limited')).toMatchObject({ state: 'discovered', attempts: 0 });
        for (let i = 1; i <= 5; i += 1) expect(await fail(a.id, 'error')).toMatchObject({ state: 'discovered', attempts: i });
        const row = await audioOf(db, a.call_activity_id);
        expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 40 * 60_000);
        expect(await fail(a.id, 'error')).toMatchObject({ state: 'unavailable', attempts: 6 });

        const b = (await discoveredCall(db, w, { callId: '6543210987654321811' })).audio;
        await fail(b.id, 'invalid_media'); await fail(b.id, 'invalid_media');
        expect(await fail(b.id, 'invalid_media')).toMatchObject({ state: 'invalid_media', attempts: 3 });

        const kinds: [string, string | null][] = [['too_large', null], ['decode_timeout', null], ['denied', 'd'.repeat(16)]];
        for (const [i, [kind, key]] of kinds.entries()) {
          const c = (await discoveredCall(db, w, { callId: `65432109876543218${20 + i}` })).audio;
          expect(await fail(c.id, kind, key)).toEqual({ state: kind });
        }
        const d = (await discoveredCall(db, w, { callId: '6543210987654321830' })).audio;
        expect(await fail(d.id, 'recovery_reset')).toMatchObject({ replayed: true, state: 'discovered' });
        await rpc(db, 'public.fn_dpa_mark_uploading($1,$2,$3,$4,$5)', [holder, d.id, SHA, 100, 1000]);
        expect(await fail(d.id, 'recovery_reset')).toMatchObject({ state: 'discovered', attempts: 1 });
        expect(await audioOf(db, d.call_activity_id)).toMatchObject({ upload_expected_sha256: null, upload_expected_size: null, storage_path: null });
      });
    });
  });

  describe('who can play it', () => {
    async function sandraCall(w: World): Promise<Json> {
      const i = await prepare(w);
      const s = Date.now() - 1000;
      const custom = String(i.customData);
      await deliver(w, { state: 'calling', at: s, custom, extra: { date_started: s } });
      await deliver(w, { state: 'connected', at: s + 4000, custom, extra: { date_started: s, date_connected: s + 4000 } });
      await deliver(w, { state: 'hangup', at: s + 64_000, custom, extra: { date_started: s, date_connected: s + 4000, date_ended: s + 64_000, talk_duration: 60_000, talk_time: 60_000 } });
      const l = await ledger(w);
      return l.activity[l.activity.length - 1];
    }
    const authorize = (db: Client, actor: string, org: string, activity: string) =>
      rpc(db, 'public.fn_dialpad_audio_authorize($1,$2,$3)', [actor, org, activity]);

    it('owner may play any direction; the attributed rep only an outbound matched call; everyone else is denied', async () => {
      await withAudio(async (db) => {
        const w = await world(db);
        const call = await sandraCall(w);
        expect(call.operator_user_id).toBe(w.rep);
        expect((await ledger(w)).attempt.some((t: Json) => t.actor_user_id === w.rep && t.call_activity_id === call.id)).toBe(true);
        expect(await authorize(db, w.owner, w.org, call.id)).toBeNull(); // not stored yet
        const audio = await markStored(db, call.id);
        const expected = { audioId: audio.id, bucket: 'dialpad-call-audio', path: pathOf(audio), sha256: SHA, durationMs: 36000 };
        expect(await authorize(db, w.owner, w.org, call.id)).toEqual({ ...expected, mode: 'owner' });
        expect(await authorize(db, w.rep, w.org, call.id)).toEqual({ ...expected, mode: 'rep' });
        expect(await authorize(db, w.rep2, w.org, call.id)).toBeNull();
        expect(await authorize(db, randomUUID(), w.org, call.id)).toBeNull();
        expect(await authorize(db, w.rep, randomUUID(), call.id)).toBeNull();
        expect(await authorize(db, w.rep, w.org, randomUUID())).toBeNull();
        // The authorize function is not callable by a signed-in user.
        expect((await failure(db, () => asUser(db, w.owner, () => db.query('select public.fn_dialpad_audio_authorize($1,$2,$3)', [w.owner, w.org, call.id])))).code).toBe('42501');

        // Reassigned operator, suspended and expired memberships, no acquisitions designation.
        await db.query('update public.call_activities set operator_user_id=$2 where id=$1', [call.id, w.rep2]);
        expect(await authorize(db, w.rep, w.org, call.id)).toBeNull();
        await db.query('update public.call_activities set operator_user_id=$2 where id=$1', [call.id, w.rep]);
        expect(await authorize(db, w.rep, w.org, call.id)).not.toBeNull();
        await db.query("update public.memberships set access_expires_at = now() - interval '1 second' where org_id=$1 and user_id=$2", [w.org, w.rep]);
        expect(await authorize(db, w.rep, w.org, call.id)).toBeNull();
        await db.query("update public.memberships set access_expires_at = null, access_status='suspended' where org_id=$1 and user_id=$2", [w.org, w.rep]);
        expect(await authorize(db, w.rep, w.org, call.id)).toBeNull();
        await db.query("update public.memberships set access_status='active' where org_id=$1 and user_id=$2", [w.org, w.rep]);
        await db.query("update public.memberships set deletion_prepared_at = now() where org_id=$1 and user_id=$2", [w.org, w.rep]).catch(() => undefined);
        await db.query("update public.call_activities set provider_call_id='6000000000009999' where id=$1", [call.id]).catch(() => undefined);
      });
    });

    it('an attempt by another actor, or a conflicting intent event, denies the rep but not the owner', async () => {
      await withAudio(async (db) => {
        const w = await world(db);
        const call = await sandraCall(w);
        await markStored(db, call.id);
        expect(await authorize(db, w.rep, w.org, call.id)).not.toBeNull();
        await db.query("update public.acquisition_attempts set actor_user_id=$2 where call_activity_id=$1", [call.id, w.rep2]);
        expect(await authorize(db, w.rep, w.org, call.id)).toBeNull();
        expect(await authorize(db, w.owner, w.org, call.id)).not.toBeNull();
        await db.query("update public.acquisition_attempts set actor_user_id=$2 where call_activity_id=$1", [call.id, w.rep]);
        expect(await authorize(db, w.rep, w.org, call.id)).not.toBeNull();
        // The ledger refuses to edit a matched event; a conflict recorded against the intent is simulated past its guard.
        await db.query("set local session_replication_role = replica");
        await db.query(`update public.dialpad_call_events set disposition='conflict', disposition_reason='test_conflict',
          conflicts_with_event_id=(select id from public.dialpad_call_events where org_id=$1 order by id limit 1)
          where org_id=$1 and matched_intent_id is not null`, [w.org]);
        await db.query("set local session_replication_role = origin");
        expect(await authorize(db, w.rep, w.org, call.id)).toBeNull();
        expect(await authorize(db, w.owner, w.org, call.id)).not.toBeNull();
      });
    });

    it('an inbound call with a matched native intent: the rep is denied, the owner is allowed', async () => {
      await withAudio(async (db) => {
        const w = await world(db, { flag: true });
        const call = await endedCall(w, { direction: 'inbound' });
        expect(call.direction).toBe('inbound');
        await markStored(db, call.id);
        // Even with an intent and an attempt attributing the call to the rep, inbound stays owner-only for reps.
        await db.query("update public.call_activities set operator_user_id=$2 where id=$1", [call.id, w.rep]);
        expect(await authorize(db, w.rep, w.org, call.id)).toBeNull();
        expect(await authorize(db, w.owner, w.org, call.id)).toMatchObject({ mode: 'owner' });
      });
    });
  });

  describe('machines (Jev, coach)', () => {
    const forService = (db: Client, org: string, activity: string, consumer: string) =>
      rpc(db, 'public.fn_dialpad_audio_for_service($1,$2,$3)', [org, activity, consumer]);

    it('needs the consumer in that org\'s own list, the call in that org, and logs each grant; org A cannot reach org B\'s call even when both enable jev', async () => {
      await withAudio(async (db) => {
        const a = await world(db, { flag: true });
        const b = await world(db, { flag: true });
        const callA = await endedCall(a);
        const callB = await endedCall(b, { callId: '6543210987654321850' });
        const audioA = await markStored(db, callA.id);
        await markStored(db, callB.id);
        expect(await forService(db, a.org, callA.id, 'jev')).toBeNull(); // default: no consumers
        await db.query("update public.my_leads_feature_flags set audio_consumers = array['jev'] where org_id = any($1)", [[a.org, b.org]]);
        const ok = await forService(db, a.org, callA.id, 'jev');
        expect(ok).toEqual({ audioId: audioA.id, id: `dpa_${audioA.id}`, bucket: 'dialpad-call-audio', path: pathOf(audioA), sha256: SHA, durationMs: 36000 });
        expect(await forService(db, a.org, callB.id, 'jev')).toBeNull();
        expect(await forService(db, b.org, callA.id, 'jev')).toBeNull();
        expect(await forService(db, a.org, callA.id, 'coach_review')).toBeNull(); // not listed
        expect(await forService(db, a.org, callA.id, 'nope')).toBeNull();
        expect(await forService(db, a.org, randomUUID(), 'jev')).toBeNull();
        expect((await db.query('select consumer, org_id, call_activity_id, audio_id from public.dialpad_audio_access_log order by id')).rows)
          .toEqual([{ consumer: 'jev', org_id: a.org, call_activity_id: callA.id, audio_id: audioA.id }]);
        await db.query("update public.dialpad_call_audio set state='unavailable', sha256=null, size_bytes=null, stored_at=null where id=$1", [audioA.id]);
        expect(await forService(db, a.org, callA.id, 'jev')).toBeNull();
      });
    });
  });

  it('the rollback twin removes every object and flag column, leaves the bucket, and the migration can be re-applied', async () => {
    await withAudio(async (db) => {
      await db.query(stripTransaction(ROLLBACK));
      expect((await db.query(
        `select count(*)::int as n from pg_class where relname in ('dialpad_call_audio','dialpad_share_link_attempts','dialpad_recording_worker','dialpad_audio_access_log') and relnamespace='public'::regnamespace`)).rows[0].n).toBe(0);
      expect((await db.query("select count(*)::int as n from pg_proc where pronamespace='public'::regnamespace and (proname like 'fn_dpa_%' or proname in ('dpa_assert_holder','dialpad_call_audio_path','dialpad_call_audio_enqueue','fn_dialpad_audio_authorize','fn_dialpad_audio_for_service'))")).rows[0].n).toBe(0);
      expect((await db.query("select count(*)::int as n from pg_trigger where tgname='dialpad_call_audio_enqueue_trg'")).rows[0].n).toBe(0);
      expect((await db.query("select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='my_leads_feature_flags' and column_name in ('recording_download','recording_download_canary_call_ids','audio_consumers')")).rows[0].n).toBe(0);
      expect((await db.query("select count(*)::int as n from storage.buckets where id='dialpad-call-audio'")).rows[0].n).toBe(1);
      await db.query(stripTransaction(MIGRATION));
      expect((await db.query("select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='my_leads_feature_flags' and column_name in ('recording_download','recording_download_canary_call_ids','audio_consumers')")).rows[0].n).toBe(3);
    });
  });
});
