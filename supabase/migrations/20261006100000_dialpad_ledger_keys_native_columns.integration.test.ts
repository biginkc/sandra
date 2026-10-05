import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { stripTransaction } from '@tests/integration/my-leads-housekeeping-fixture';
import { CALL, deliver, failure, ledger, nativeCall, prepare, withP2, world } from '@tests/integration/dialpad-p2-fixture';

// Local-only (rolled-back transaction per test; works on an empty or already-migrated database).
describe('20261006100000 shared ledger keys', () => {
  it('leaves no literal dialpad-cti: in any live function, index or constraint (outside the two helpers)', async () => {
    await withP2('ledgerKeys', async (db) => {
      const fns = await db.query(
        `select p.oid::regprocedure::text as sig from pg_proc p
          where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
            and p.proname not in ('dialpad_cti_is_ledger_key', 'dialpad_cti_intent_key')
            and pg_get_functiondef(p.oid) like '%dialpad-cti:%'`);
      expect(fns.rows).toEqual([]);
      const idx = await db.query("select indexname from pg_indexes where indexdef like '%dialpad-cti:%'");
      expect(idx.rows).toEqual([]);
      const con = await db.query("select conname from pg_constraint where pg_get_constraintdef(oid) like '%dialpad-cti:%'");
      expect(con.rows).toEqual([]);
    });
  });

  it('helper truth table', async () => {
    await withP2('ledgerKeys', async (db) => {
      const id = randomUUID();
      const r = await db.query(
        `select public.dialpad_cti_is_ledger_key('dialpad-cti:abc') a, public.dialpad_cti_is_ledger_key('dialpad-native:123') b,
                public.dialpad_cti_is_ledger_key('dialpad-foo:x') c, public.dialpad_cti_is_ledger_key(null) d,
                public.dialpad_cti_is_ledger_key('garbage') e,
                public.dialpad_cti_intent_key('sandra', $1, '55') s, public.dialpad_cti_intent_key('native', $1, '55') n`, [id]);
      expect(r.rows[0]).toEqual({ a: true, b: true, c: false, d: null, e: false, s: `dialpad-cti:${id}`, n: 'dialpad-native:55' });
    });
  });

  it('pending-outcome check accepts both ledger keys and rejects anything else', async () => {
    await withP2('ledgerKeys', async (db) => {
      const w = await world(db);
      const ep = (await db.query('select id from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null', [w.property])).rows[0].id;
      const attempt = (key: string | null, source = 'dialpad') => db.query(
        `insert into public.acquisition_attempts(org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,occurred_at,provider_attempt_key,idempotency_key)
         values ($1,$2,$3,$4,'call',$5,now(),$6,$7)`, [w.org, w.property, ep, w.rep, source, key, randomUUID()]);
      await attempt('dialpad-cti:test');
      await attempt('dialpad-native:6543210987654321098');
      expect((await failure(db, () => attempt('dialpad-foo:x'))).code).toBe('23514');
      expect((await failure(db, () => attempt(null))).code).toBe('23514');
    });
  });

  it('a Sandra intent still projects exactly once and replays idempotently (ON CONFLICT inference)', async () => {
    await withP2('ledgerKeys', async (db) => {
      const w = await world(db);
      const intent = await prepare(w);
      const evs = nativeCall(w).map((e) => ({ ...e, custom: String(intent.customData) }));
      for (const e of evs) await deliver(w, e);
      for (const e of evs) await deliver(w, e);
      await db.query('select public.dialpad_cti_project_intent($1)', [intent.intentId]);
      const l = await ledger(w);
      expect(l.activity).toHaveLength(1);
      expect(l.attempt).toHaveLength(1);
      expect(l.activity[0].jitter_attempt_id).toBe(`dialpad-cti:${intent.intentId}`);
      expect(l.attempt[0].provider_attempt_key).toBe(`dialpad-cti:${intent.intentId}`);
      expect(l.intent[0]).toMatchObject({ origin: 'sandra', direction: 'outbound' });
    });
  });

  it('origin and direction are immutable and constrained', async () => {
    await withP2('ledgerKeys', async (db) => {
      const w = await world(db);
      const intent = await prepare(w);
      expect((await failure(db, () => db.query("update public.dialpad_call_intents set origin='native' where id=$1", [intent.intentId]))).code).toBe('42501');
      expect((await failure(db, () => db.query("update public.dialpad_call_intents set direction='inbound' where id=$1", [intent.intentId]))).code).toBe('42501');
      expect((await failure(db, () => db.query("update public.dialpad_call_intents set origin='x' where id=$1", [intent.intentId]))).code).toMatch(/23514|42501/);
    });
  });

  it('a native-keyed activity and attempt are visible to the references function and finalizable', async () => {
    await withP2('ledgerKeys', async (db) => {
      const w = await world(db);
      const ep = (await db.query('select id from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null', [w.property])).rows[0].id;
      const key = `dialpad-native:${CALL}`;
      const act = (await db.query(
        `insert into public.call_activities(org_id,property_id,contact_id,jitter_attempt_id,operator_user_id,started_at,ended_at,outcome,provider,provider_call_id,direction,call_purpose)
         values ($1,$2,$3,$4,$5,now(),now(),'unknown','dialpad',$6,'outbound','customer') returning id`, [w.org, w.property, w.contact, key, w.rep, CALL])).rows[0].id;
      await db.query(
        `insert into public.acquisition_attempts(org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,occurred_at,call_activity_id,provider_attempt_key,idempotency_key)
         values ($1,$2,$3,$4,'call','dialpad',now(),$5,$6,$7)`, [w.org, w.property, ep, w.rep, act, key, randomUUID()]);
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [w.rep]);
      const r = (await db.query('select public.fn_get_acquisition_call_references($1,$2,$3) as v', [w.org, w.property, w.rep])).rows[0].v;
      expect(r).toHaveLength(1);
      const done = (await db.query('select public.fn_finalize_acquisition_attempt($1::jsonb) as v', [
        JSON.stringify({ orgId: w.org, propertyId: w.property, callActivityId: act, idempotencyKey: randomUUID(), outcome: 'no_answer' })])).rows[0].v;
      expect(done).toMatchObject({ ok: true, duplicate: false });
      await db.query('reset role');
    });
  });

  it('re-running the migration is a no-op', async () => {
    await withP2('ledgerKeys', async (db) => {
      await db.query(stripTransaction('migrations/20261006100000_dialpad_ledger_keys_native_columns.sql'));
      const r = await db.query("select count(*)::int n from pg_indexes where indexname like 'idx_call_activities_org_dialpad_%'");
      expect(r.rows[0].n).toBe(2);
    });
  });
});
