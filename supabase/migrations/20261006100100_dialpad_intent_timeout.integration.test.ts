import { describe, expect, it } from 'vitest';
import { stripTransaction } from '@tests/integration/my-leads-housekeeping-fixture';
import { deliver, failure, ledger, nativeCall, prepare, service, setFlag, withP2, world, type World, type Json } from '@tests/integration/dialpad-p2-fixture';

const authorize = (w: World, id: string, secondsAgo: number) =>
  w.db.query(`update public.dialpad_call_intents set dispatch_authorized_at = now() - make_interval(secs => $2) where id = $1`, [id, secondsAgo]);
const sweep = async (w: World, cutoff = 120): Promise<number> =>
  (await service(w.db, () => w.db.query('select public.fn_fail_stale_dialpad_intents($1) as n', [cutoff]))).rows[0].n;
const failedAt = async (w: World, id: string) =>
  (await w.db.query('select failed_at from public.dialpad_call_intents where id=$1', [id])).rows[0].failed_at;
const status = async (w: World, id: string): Promise<Json> =>
  (await service(w.db, () => w.db.query('select public.fn_get_dialpad_call_status($1,$2,$3) as v', [w.org, w.rep, id]))).rows[0].v;

describe('20261006100100 intent timeout marker', () => {
  it('marks an authorized intent after 120 s and not before', async () => {
    await withP2('intentTimeout', async (db) => {
      const w = await world(db, { flag: true });
      const early = await prepare(w);
      await authorize(w, early.intentId, 119);
      expect(await sweep(w)).toBe(0);
      expect(await failedAt(w, early.intentId)).toBeNull();
      const late = await prepare(w, w.property, w.contact);
      await authorize(w, late.intentId, 121);
      expect(await sweep(w)).toBe(1);
      expect(await failedAt(w, late.intentId)).not.toBeNull();
      expect(await failedAt(w, early.intentId)).toBeNull();
      expect(await sweep(w)).toBe(0); // set once
      expect((await status(w, late.intentId)).state).toBe('failed');
    });
  });

  it('never marks a prepared intent that was not authorized', async () => {
    await withP2('intentTimeout', async (db) => {
      const w = await world(db, { flag: true });
      const i = await prepare(w);
      expect(await sweep(w)).toBe(0);
      expect(await failedAt(w, i.intentId)).toBeNull();
    });
  });

  it('a failed intent counts as no touch: no activity, attempt, clock or stage change', async () => {
    await withP2('intentTimeout', async (db) => {
      const w = await world(db, { flag: true });
      const i = await prepare(w);
      await authorize(w, i.intentId, 300);
      expect(await sweep(w)).toBe(1);
      const l = await ledger(w);
      expect(l.activity).toHaveLength(0);
      expect(l.attempt).toHaveLength(0);
      const ep = (await db.query('select first_call_started_at from public.acquisition_assignment_episodes where property_id=$1', [w.property])).rows[0];
      expect(ep.first_call_started_at).toBeNull();
      expect((await db.query('select count(*)::int n from public.acquisition_queue_states where property_id=$1', [w.property])).rows[0].n).toBe(0);
    });
  });

  it('a late event inside the intent window still matches and projects once; failed_at is retained', async () => {
    await withP2('intentTimeout', async (db) => {
      const w = await world(db, { flag: true });
      const i = await prepare(w);
      await authorize(w, i.intentId, 300);
      await sweep(w);
      const marked = await failedAt(w, i.intentId);
      expect(marked).not.toBeNull();
      for (const e of nativeCall(w).map((x) => ({ ...x, custom: String(i.customData) }))) await deliver(w, e);
      const l = await ledger(w);
      expect(l.activity).toHaveLength(1);
      expect(l.attempt).toHaveLength(1);
      expect(l.intent[0].status).toBe('matched');
      expect(l.intent[0].failed_at).toEqual(marked);
      expect((await status(w, i.intentId)).state).toBe('ended');
    });
  });

  it('an intent matched before the cutoff is never marked', async () => {
    await withP2('intentTimeout', async (db) => {
      const w = await world(db, { flag: true });
      const i = await prepare(w);
      await authorize(w, i.intentId, 300);
      const [calling] = nativeCall(w);
      await deliver(w, { ...calling!, custom: String(i.customData) });
      expect(await sweep(w)).toBe(0);
      expect(await failedAt(w, i.intentId)).toBeNull();
    });
  });

  it('an already-expired intent is untouched: it stays expired, never relabeled failed', async () => {
    await withP2('intentTimeout', async (db) => {
      const w = await world(db, { flag: true });
      const i = await prepare(w);
      await authorize(w, i.intentId, 3600);
      await db.query('set local session_replication_role = replica'); // evidence rows are immutable; age this one directly
      await db.query(
        "update public.dialpad_call_intents set prepared_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1",
        [i.intentId]);
      await db.query('set local session_replication_role = origin');
      expect(await sweep(w)).toBe(0);
      expect(await failedAt(w, i.intentId)).toBeNull();
      expect((await status(w, i.intentId)).state).toBe('expired');
    });
  });

  it('a failed intent past its window reports expired (failed_at stays as the marker); a failed one inside the window reports failed', async () => {
    await withP2('intentTimeout', async (db) => {
      const w = await world(db, { flag: true });
      const i = await prepare(w);
      await authorize(w, i.intentId, 300);
      await sweep(w);
      expect((await status(w, i.intentId)).state).toBe('failed');
      await db.query('set local session_replication_role = replica'); // evidence rows are immutable; age this one directly
      await db.query(
        "update public.dialpad_call_intents set prepared_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' where id = $1",
        [i.intentId]);
      await db.query('set local session_replication_role = origin');
      expect((await status(w, i.intentId)).state).toBe('expired');
      expect(await failedAt(w, i.intentId)).not.toBeNull();
    });
  });

  it('is inert until the org native_matcher flag is on', async () => {
    await withP2('intentTimeout', async (db) => {
      const w = await world(db);
      const i = await prepare(w);
      await authorize(w, i.intentId, 300);
      expect(await sweep(w)).toBe(0);
      expect(await failedAt(w, i.intentId)).toBeNull();
      await setFlag(db, w.org, 'native_matcher', true);
      expect(await sweep(w)).toBe(1);
    });
  });

  it('the guard refuses clearing or moving the marker and refuses it on an unauthorized intent', async () => {
    await withP2('intentTimeout', async (db) => {
      const w = await world(db, { flag: true });
      const i = await prepare(w);
      expect((await failure(db, () => db.query('update public.dialpad_call_intents set failed_at=now() where id=$1', [i.intentId]))).code).toBe('42501');
      await authorize(w, i.intentId, 300);
      await sweep(w);
      expect((await failure(db, () => db.query('update public.dialpad_call_intents set failed_at=null where id=$1', [i.intentId]))).code).toBe('42501');
      expect((await failure(db, () => db.query("update public.dialpad_call_intents set failed_at=now() + interval '1 minute' where id=$1", [i.intentId]))).code).toBe('42501');
    });
  });

  it('the sweep is service-only and validates its inputs', async () => {
    await withP2('intentTimeout', async (db) => {
      const w = await world(db, { flag: true });
      await db.query('set local role authenticated');
      expect((await failure(db, () => db.query('select public.fn_fail_stale_dialpad_intents(120)'))).code).toBe('42501');
      await db.query('reset role');
      expect((await failure(db, () => service(db, () => db.query('select public.fn_fail_stale_dialpad_intents(5)')))).code).toBe('22023');
      void w;
    });
  });

  it('re-running the migration is a no-op', async () => {
    await withP2('intentTimeout', async (db) => {
      await db.query(stripTransaction('migrations/20261006100100_dialpad_intent_timeout.sql'));
      const def = (await db.query("select pg_get_functiondef('public.dialpad_cti_guard_intent()'::regprocedure) d")).rows[0].d as string;
      expect(def.split("failed marker is set once").length - 1).toBe(1);
    });
  });
});
