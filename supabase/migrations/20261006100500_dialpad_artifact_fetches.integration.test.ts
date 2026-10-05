import { describe, expect, it } from 'vitest';
import { stripTransaction } from '@tests/integration/my-leads-housekeeping-fixture';
import { deliver, failure, ledger, nativeCall, prepare, service, setFlag, withP2, world, type Json, type World } from '@tests/integration/dialpad-p2-fixture';

// A finished customer call, dated in the past so its fetches are due.
async function endedCall(w: World, o: Parameters<typeof nativeCall>[1] = {}): Promise<Json> {
  await setFlag(w.db, w.org, 'artifact_fetch', true);
  w.now = Date.now() - 3 * 3_600_000;
  for (const e of nativeCall(w, o)) await deliver(w, e);
  return (await ledger(w)).activity[0];
}
const fetches = async (w: World): Promise<Json[]> =>
  (await w.db.query('select * from public.dialpad_call_artifact_fetches where org_id=$1 order by artifact', [w.org])).rows;
const claim = async (w: World, limit = 10, lease = 120): Promise<Json[]> =>
  (await service(w.db, () => w.db.query('select public.fn_claim_dialpad_artifact_fetches($1,$2) as v', [limit, lease]))).rows[0].v;
const record = async (w: World, id: string, outcome: string, o: { error?: string; text?: string; language?: string; summary?: string } = {}): Promise<Json> =>
  (await service(w.db, () => w.db.query('select public.fn_record_dialpad_artifact_result($1,$2,$3,$4,$5,$6) as v',
    [id, outcome, o.error ?? null, o.text ?? null, o.language ?? null, o.summary ?? null]))).rows[0].v;
const row = async (w: World, artifact: string): Promise<Json> => (await fetches(w)).find((r) => r.artifact === artifact)!;
const transcript = async (w: World, activity: string): Promise<Json | undefined> =>
  (await w.db.query('select * from public.call_transcripts where call_activity_id=$1', [activity])).rows[0];

describe('20261006100500 artifact fetch queue', () => {
  it('enqueues transcript, recap and recording_link for an ended answered outbound customer call; replay adds nothing', async () => {
    await withP2('artifactFetches', async (db) => {
      const w = await world(db, { flag: true });
      const a = await endedCall(w);
      const rows = await fetches(w);
      expect(rows.map((r) => r.artifact)).toEqual(['recap', 'recording_link', 'transcript']);
      expect(rows.every((r) => r.state === 'pending' && r.attempts === 0 && r.call_activity_id === a.id && r.provider_call_id === a.provider_call_id)).toBe(true);
      const t = rows.find((r) => r.artifact === 'transcript')!;
      const l = rows.find((r) => r.artifact === 'recording_link')!;
      expect(new Date(t.next_attempt_at).getTime() - new Date(t.ended_at).getTime()).toBe(60_000);
      expect(new Date(l.next_attempt_at).getTime() - new Date(l.ended_at).getTime()).toBe(600_000);
      for (const e of nativeCall(w)) await deliver(w, e);
      await db.query('select public.dialpad_cti_project_intent($1)', [(await ledger(w)).intent[0].id]);
      expect(await fetches(w)).toHaveLength(3);
    });
  });

  it('enqueues nothing for no-answer, voicemail or training calls, and no recording_link for inbound', async () => {
    await withP2('artifactFetches', async (db) => {
      const w = await world(db, { flag: true });
      await endedCall(w, { answered: false });
      expect(await fetches(w)).toHaveLength(0);

      const v = await world(db);
      const i = await prepare(v);
      const s = v.now + 1000;
      const custom = String(i.customData);
      await deliver(v, { state: 'calling', at: s, custom, extra: { date_started: s } });
      await deliver(v, { state: 'voicemail', at: s + 20_000, custom, extra: { date_started: s } });
      await deliver(v, { state: 'hangup', at: s + 30_000, custom, extra: { date_started: s, date_ended: s + 30_000, talk_time: 0, voicemail_link: 'https://dialpad.com/v' } });
      expect((await ledger(v)).activity[0].outcome).toBe('voicemail');
      expect(await fetches(v)).toHaveLength(0);

      const t = await world(db, { flag: true, training: true });
      await endedCall(t);
      expect(await fetches(t)).toHaveLength(0);

      const inb = await world(db, { flag: true });
      await endedCall(inb, { direction: 'inbound' });
      expect((await fetches(inb)).map((r) => r.artifact)).toEqual(['recap', 'transcript']);
    });
  });

  it('claim returns only due transcript/recap rows, leases them, and never returns them twice', async () => {
    await withP2('artifactFetches', async (db) => {
      const w = await world(db, { flag: true });
      await endedCall(w);
      const first = await claim(w);
      expect(first.map((r) => r.artifact).sort()).toEqual(['recap', 'transcript']);
      expect(first[0]).toHaveProperty('providerCallId');
      expect(await claim(w)).toEqual([]); // leased
      await db.query("update public.dialpad_call_artifact_fetches set lease_until = null where org_id=$1", [w.org]);
      const onlyTranscripts = (await service(db, () => db.query("select public.fn_claim_dialpad_artifact_fetches(10,120,array['transcript']) as v"))).rows[0].v;
      expect(onlyTranscripts.map((r: Json) => r.artifact)).toEqual(['transcript']);
      await db.query("update public.dialpad_call_artifact_fetches set lease_until = null where org_id=$1", [w.org]);
      await db.query("update public.dialpad_call_artifact_fetches set lease_until = now() - interval '1 second' where org_id=$1", [w.org]);
      expect(await claim(w)).toHaveLength(2); // lease expired
      await db.query("update public.dialpad_call_artifact_fetches set lease_until = null, next_attempt_at = now() + interval '1 hour' where org_id=$1", [w.org]);
      expect(await claim(w)).toEqual([]); // not due
    });
  });

  it('transcript available writes call_transcripts and flips the activity status; recap fills the summary; monotonic', async () => {
    await withP2('artifactFetches', async (db) => {
      const w = await world(db, { flag: true });
      const a = await endedCall(w);
      const t = await row(w, 'transcript');
      const r = await row(w, 'recap');
      expect(await record(w, r.id, 'available', { summary: 'Seller wants 200k.' })).toMatchObject({ state: 'available' });
      expect(await transcript(w, a.id)).toMatchObject({ status: 'pending', summary: 'Seller wants 200k.', summary_status: 'available' });
      expect(await record(w, t.id, 'available', { text: 'hello there', language: 'en' })).toMatchObject({ state: 'available' });
      expect(await transcript(w, a.id)).toMatchObject({ status: 'available', text: 'hello there', language: 'en', summary: 'Seller wants 200k.', summary_status: 'available' });
      const act = (await db.query('select transcript_status, summary_status from public.call_activities where id=$1', [a.id])).rows[0];
      expect(act).toMatchObject({ transcript_status: 'available', summary_status: 'available' });
      // a replay does not move anything back or change the stored text
      expect(await record(w, t.id, 'error', { error: '500' })).toMatchObject({ state: 'available', replayed: true });
      expect((await transcript(w, a.id))?.text).toBe('hello there');
      expect((await row(w, 'transcript')).ready_at).not.toBeNull();
    });
  });

  it('not_ready advances to the 5, 15 and 60 minute offsets from hangup, then becomes unavailable after the fourth', async () => {
    await withP2('artifactFetches', async (db) => {
      const w = await world(db, { flag: true });
      await endedCall(w);
      const t = await row(w, 'transcript');
      // pin hangup to "now" so the future offsets are observable
      await db.query("update public.dialpad_call_artifact_fetches set ended_at = now() where id=$1", [t.id]);
      const mins = (r: Json) => Math.round((new Date(r.next_attempt_at).getTime() - new Date(r.ended_at).getTime()) / 60_000);
      expect(await record(w, t.id, 'not_ready')).toMatchObject({ state: 'pending', attempts: 1 });
      expect(mins(await row(w, 'transcript'))).toBe(5);
      await record(w, t.id, 'error', { error: '503' });
      expect(mins(await row(w, 'transcript'))).toBe(15);
      expect((await row(w, 'transcript')).last_error).toBe('503');
      await record(w, t.id, 'not_ready');
      expect(mins(await row(w, 'transcript'))).toBe(60);
      expect(await record(w, t.id, 'not_ready')).toMatchObject({ state: 'unavailable', attempts: 4 });
      expect((await claim(w)).map((x) => x.artifact)).not.toContain('transcript');
      expect(await record(w, t.id, 'available', { text: 'late' })).toMatchObject({ state: 'unavailable', replayed: true });
    });
  });

  it('a late result is rescheduled no earlier than now; denied is terminal and recorded', async () => {
    await withP2('artifactFetches', async (db) => {
      const w = await world(db, { flag: true });
      await endedCall(w); // hangup three hours ago
      const t = await row(w, 'transcript');
      await record(w, t.id, 'not_ready');
      expect(new Date((await row(w, 'transcript')).next_attempt_at).getTime()).toBeGreaterThanOrEqual(Date.now() - 5000);
      const r = await row(w, 'recap');
      expect(await record(w, r.id, 'denied', { error: '403' })).toMatchObject({ state: 'denied' });
      expect((await row(w, 'recap')).last_error).toBe('403');
      expect((await claim(w)).map((x) => x.artifact)).not.toContain('recap');
    });
  });

  it('recording_link: available when the link reached the attempt, flagged otherwise; no provider call', async () => {
    await withP2('artifactFetches', async (db) => {
      const w = await world(db, { flag: true });
      await endedCall(w);
      await db.query("update public.dialpad_call_artifact_fetches set next_attempt_at = now() - interval '1 second' where org_id=$1 and artifact='recording_link'", [w.org]);
      let out = (await service(db, () => db.query('select public.fn_resolve_dialpad_recording_links(50) as v'))).rows[0].v;
      expect(out.available).toBe(0);
      expect(out.flagged).toHaveLength(1);
      expect(await row(w, 'recording_link')).toMatchObject({ state: 'flagged', last_error: 'missing_link' });

      const w2 = await world(db, { flag: true });
      await endedCall(w2);
      await db.query("update public.acquisition_attempts set recording_url='https://dialpad.com/callreview/x' where org_id=$1", [w2.org]);
      await db.query("update public.dialpad_call_artifact_fetches set next_attempt_at = now() - interval '1 second' where org_id=$1 and artifact='recording_link'", [w2.org]);
      out = (await service(db, () => db.query('select public.fn_resolve_dialpad_recording_links(50) as v'))).rows[0].v;
      expect(out.available).toBeGreaterThanOrEqual(1);
      expect(await row(w2, 'recording_link')).toMatchObject({ state: 'available' });
    });
  });

  it('without the artifact_fetch flag nothing is claimed or resolved, and flipping it on releases the rows', async () => {
    await withP2('artifactFetches', async (db) => {
      const w = await world(db, { flag: true });
      await endedCall(w);
      await setFlag(db, w.org, 'artifact_fetch', false);
      await db.query("update public.dialpad_call_artifact_fetches set next_attempt_at = now() - interval '1 second' where org_id=$1", [w.org]);
      expect(await claim(w)).toEqual([]);
      const out = (await service(db, () => db.query('select public.fn_resolve_dialpad_recording_links(50) as v'))).rows[0].v;
      expect(out).toEqual({ available: 0, flagged: [] });
      await db.query('delete from public.my_leads_feature_flags where org_id=$1', [w.org]);
      expect(await claim(w)).toEqual([]); // a missing row reads OFF
      await setFlag(db, w.org, 'artifact_fetch', true);
      expect(await claim(w)).toHaveLength(2);
    });
  });

  it('every function is service-only and the table is closed to browser roles', async () => {
    await withP2('artifactFetches', async (db) => {
      for (const role of ['authenticated', 'anon']) {
        for (const sql of [
          'select public.fn_claim_dialpad_artifact_fetches(1,60)',
          "select public.fn_record_dialpad_artifact_result(gen_random_uuid(),'error')",
          'select public.fn_resolve_dialpad_recording_links(1)',
          'select * from public.dialpad_call_artifact_fetches',
        ]) {
          await db.query(`set local role ${role}`);
          expect((await failure(db, () => db.query(sql))).code).toBe('42501');
          await db.query('reset role');
        }
      }
      expect((await failure(db, () => service(db, () => db.query("select public.fn_claim_dialpad_artifact_fetches(0,60)")))).code).toBe('22023');
      expect((await failure(db, () => service(db, () => db.query("select public.fn_record_dialpad_artifact_result(gen_random_uuid(),'bogus')")))).code).toBe('22023');
    });
  });

  it('re-applying the migration after its rollback restores an equivalent schema', async () => {
    await withP2('artifactFetches', async (db) => {
      await db.query(stripTransaction('rollbacks/20261006100500_dialpad_artifact_fetches.sql'));
      expect((await db.query("select to_regclass('public.dialpad_call_artifact_fetches') t")).rows[0].t).toBeNull();
      await db.query(stripTransaction('migrations/20261006100500_dialpad_artifact_fetches.sql'));
      expect((await db.query("select to_regclass('public.dialpad_call_artifact_fetches') t")).rows[0].t).not.toBeNull();
    });
  });
});
