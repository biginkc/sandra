import { describe, expect, it } from 'vitest';
import { stripTransaction } from '@tests/integration/my-leads-housekeeping-fixture';
import { addLead, deliver, failure, ledger, nativeCall, payload, service, withP2, world, type Json, type World } from '@tests/integration/dialpad-p2-fixture';

const redact = async (w: World, olderThan = '30 days', limit = 500): Promise<number> =>
  (await service(w.db, () => w.db.query('select public.fn_redact_dialpad_unmatched_events($1::interval,$2) as n', [olderThan, limit]))).rows[0].n;
const age = (w: World, days: number, callId?: string) =>
  w.db.query('alter table public.dialpad_call_events disable trigger user')
    .then(() => w.db.query(`update public.dialpad_call_events set received_at = now() - make_interval(days => $2) where org_id=$1 ${callId ? 'and provider_call_id=$3' : ''}`, callId ? [w.org, days, callId] : [w.org, days]))
    .then(() => w.db.query('alter table public.dialpad_call_events enable trigger user'));
const events = async (w: World) => (await ledger(w)).event;
const UNKNOWN = '+18165559999';

describe('20261007150200 unmatched event redaction', () => {
  it('redacts only unmatched quarantined rows older than the interval, keeps five keys, is idempotent', async () => {
    await withP2('redaction', async (db) => {
      const w = await world(db, { flag: true });
      // Matched native call on the lead; a personal call to an unknown number; an ambiguous call.
      for (const e of nativeCall(w, { callId: '7100000000000000001' })) await deliver(w, e);
      for (const e of nativeCall(w, { callId: '7100000000000000002', number: UNKNOWN, offset: 5000 })) await deliver(w, e);
      await addLead(w, { contact: w.contact, address: '2 Twin St' }); // same contact on a second lead: ambiguous
      for (const e of nativeCall(w, { callId: '7100000000000000003', offset: 10_000 })) await deliver(w, e);
      const before = await events(w);
      expect(before.filter((e: Json) => e.disposition === 'quarantined' && e.disposition_reason === 'no_lead_match')).toHaveLength(3);
      expect(before.filter((e: Json) => e.disposition === 'quarantined' && e.disposition_reason === 'ambiguous_lead')).toHaveLength(3);
      expect(before.filter((e: Json) => e.disposition === 'matched')).toHaveLength(3);

      // Fresh rows: nothing to redact yet.
      expect(await redact(w)).toBe(0);
      await age(w, 31);
      expect(await redact(w)).toBe(3);
      expect(await redact(w)).toBe(0); // idempotent
      const after = await events(w);
      for (const e of after) {
        if (e.disposition_reason === 'no_lead_match') {
          expect(e.redacted_at).not.toBeNull();
          expect(Object.keys(e.payload).sort()).toEqual(['call_id', 'direction', 'event_timestamp', 'redacted', 'state']);
          expect(e.payload.redacted).toBe(true);
          // int64 ids survive in SQL (node's JSON.parse would round them, so read the text form).
          expect((await db.query("select payload->>'call_id' as c from public.dialpad_call_events where id=$1", [e.id])).rows[0].c).toBe('7100000000000000002');
          expect(e.payload_sha256).toBe(before.find((b: Json) => b.id === e.id).payload_sha256);
        } else {
          expect(e.redacted_at).toBeNull();
          expect(e.payload).toEqual(before.find((b: Json) => b.id === e.id).payload);
        }
      }
      // A redelivery of a redacted event is still an exact replay: no conflict row, no new row.
      const redelivered = nativeCall(w, { callId: '7100000000000000002', number: UNKNOWN, offset: 5000 })[0]!;
      const replay = (await service(db, () => db.query('select public.fn_ingest_dialpad_call_event($1,$2,1,$3) as v', [w.org, w.conn, payload(redelivered)]))).rows[0].v;
      expect(replay).toMatchObject({ replayed: true, conflict: false, disposition: 'quarantined' });
      expect((await events(w)).filter((e: Json) => e.disposition === 'conflict')).toHaveLength(0);
      expect(await events(w)).toHaveLength(9);
    });
  });

  it('rejects any payload change outside the redaction function and never redacts twice', async () => {
    await withP2('redaction', async (db) => {
      const w = await world(db, { flag: true });
      for (const e of nativeCall(w, { callId: '7100000000000000004', number: UNKNOWN })) await deliver(w, e);
      const [row] = await events(w);
      // Direct payload edits, with or without the stamp, are refused (also for the service role).
      for (const sql of [
        "update public.dialpad_call_events set payload = '{}'::jsonb where id=$1",
        "update public.dialpad_call_events set payload = '{}'::jsonb, redacted_at = now() where id=$1",
        'update public.dialpad_call_events set redacted_at = now() where id=$1',
      ]) {
        const err = await failure(db, () => service(db, () => db.query(sql, [row.id])));
        expect(err.code).toBe('42501');
      }
      // Even with the GUC set by hand, a matched row cannot be redacted.
      for (const e of nativeCall(w, { callId: '7100000000000000005', offset: 5000 })) await deliver(w, e);
      const matched = (await events(w)).find((e: Json) => e.disposition === 'matched');
      const err = await failure(db, async () => {
        await db.query("select set_config('dialpad_cti.redact','1',true)");
        await db.query("update public.dialpad_call_events set payload='{}'::jsonb, redacted_at=now() where id=$1", [matched.id]);
      });
      expect(err.code).toBe('42501');
      await age(w, 40);
      expect(await redact(w)).toBe(3);
      // Clearing the stamp or re-redacting is refused.
      const cleared = await failure(db, () => db.query('update public.dialpad_call_events set redacted_at = null where id=$1', [row.id]));
      expect(cleared.code).toBe('42501');
      // Limits and bounds.
      expect((await failure(db, () => redact(w, '1 hour'))).code).toBe('22023');
      expect((await failure(db, () => redact(w, '30 days', 0))).code).toBe('22023');
      // The browser role cannot call it, and an insert can never arrive pre-redacted.
      const anon = await failure(db, async () => { await db.query('set local role authenticated'); await db.query('select public.fn_redact_dialpad_unmatched_events()'); });
      expect(anon.code).toBe('42501');
    });
  });

  it('honours the limit in received_at order', async () => {
    await withP2('redaction', async (db) => {
      const w = await world(db, { flag: true });
      for (let n = 0; n < 3; n += 1) for (const e of nativeCall(w, { callId: `710000000000000001${n}`, number: UNKNOWN, offset: n * 5000 })) await deliver(w, e);
      await age(w, 45);
      expect(await redact(w, '30 days', 4)).toBe(4);
      expect(await redact(w, '30 days', 4)).toBe(4);
      expect(await redact(w, '30 days', 4)).toBe(1);
      expect((await events(w)).every((e: Json) => e.redacted_at !== null)).toBe(true);
    });
  });

  it('rollback restores the previous guard and re-apply is clean', async () => {
    await withP2('redaction', async (db) => {
      const w = await world(db, { flag: true });
      await db.query(stripTransaction('rollbacks/20261007150200_dialpad_unmatched_event_redaction.sql'));
      expect((await db.query("select pg_get_functiondef('public.dialpad_cti_guard_event()'::regprocedure) as d")).rows[0].d).not.toContain('redact');
      expect((await db.query("select to_regproc('public.fn_redact_dialpad_unmatched_events') as p")).rows[0].p).toBeNull();
      for (const e of nativeCall(w, { callId: '7100000000000000020', number: UNKNOWN })) await deliver(w, e);
      await db.query(stripTransaction('migrations/20261007150200_dialpad_unmatched_event_redaction.sql'));
      await age(w, 31);
      expect(await redact(w)).toBe(3);
    });
  });
});
