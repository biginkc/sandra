import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CALL, LEG, REP2_DIALPAD, REP_DIALPAD, addLead, deliver, failure, ingest, ledger, nativeCall, prepare, processEvent, service,
  setFlag, withP2, world, type Ev, type Json, type World,
} from '@tests/integration/dialpad-p2-fixture';

const reasons = async (w: World) =>
  (await ledger(w)).event.map((e) => `${e.disposition}:${e.disposition_reason ?? ''}`);
const run = async (w: World, evs: Ev[]) => { for (const e of evs) await deliver(w, e); return ledger(w); };
const episode = async (w: World, property = w.property): Promise<Json> =>
  (await w.db.query('select * from public.acquisition_assignment_episodes where property_id=$1 order by assigned_at desc limit 1', [property])).rows[0];
const stage = async (w: World, property = w.property) =>
  (await w.db.query('select stage from public.acquisition_queue_states where property_id=$1', [property])).rows[0]?.stage ?? null;

describe('20261006100300 native-call matching', () => {
  it('0. flag off or no flags row: the event stays quarantined no_custom_data, nothing is written', async () => {
    await withP2('nativeMatching', async (db) => {
      const w = await world(db);
      let l = await run(w, nativeCall(w));
      expect(new Set(await reasons(w))).toEqual(new Set(['quarantined:no_custom_data']));
      expect(l.intent).toHaveLength(0);
      expect(l.activity).toHaveLength(0);
      await setFlag(db, w.org, 'native_matcher', false);
      l = await run(w, nativeCall(w, { callId: '6543210987654321001', offset: 100_000 }));
      expect(l.intent).toHaveLength(0);
      // a flags table that is unreadable also reads OFF
      await db.query('savepoint s');
      await db.query('drop table public.my_leads_feature_flags cascade');
      l = await run(w, nativeCall(w, { callId: '6543210987654321002', offset: 200_000 }));
      expect(l.intent).toHaveLength(0);
      await db.query('rollback to savepoint s');
    });
  });

  it('1. one match, outbound answered: native intent, activity and pending attempt keyed by call id, clock and stage move', async () => {
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true });
      const l = await run(w, nativeCall(w));
      expect(l.intent).toHaveLength(1);
      expect(l.intent[0]).toMatchObject({ origin: 'native', direction: 'outbound', status: 'matched', property_id: w.property, rep_user_id: w.rep, matched_provider_call_id: CALL });
      expect(l.activity).toHaveLength(1);
      expect(l.activity[0]).toMatchObject({ jitter_attempt_id: `dialpad-native:${CALL}`, direction: 'outbound', call_purpose: 'customer', provider_call_id: CALL });
      expect(l.attempt).toHaveLength(1);
      expect(l.attempt[0]).toMatchObject({ provider_attempt_key: `dialpad-native:${CALL}`, source: 'dialpad', outcome: null, actor_user_id: w.rep });
      expect((await episode(w)).first_call_started_at).not.toBeNull();
      expect(await stage(w)).toBe('contacted');
      expect(new Set(await reasons(w))).toEqual(new Set(['matched:']));
    });
  });

  it('2. exact duplicate delivery and fully reversed order produce the same ledger', async () => {
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true });
      const evs = nativeCall(w);
      await run(w, evs);
      const first = await ledger(w);
      await run(w, evs);
      const again = await ledger(w);
      expect([again.intent.length, again.activity.length, again.attempt.length]).toEqual([1, 1, 1]);
      expect(again.attempt[0].id).toBe(first.attempt[0].id);

      const w2 = await world(db, { flag: true });
      const rev = await run(w2, [...nativeCall(w2)].reverse());
      expect([rev.intent.length, rev.activity.length, rev.attempt.length]).toEqual([1, 1, 1]);
      expect(rev.activity[0].ended_at).not.toBeNull();
      expect(new Set(await reasons(w2))).toEqual(new Set(['matched:']));
    });
  });

  it('3. several matches (one contact on two properties; two contacts sharing a number): ambiguous_lead, no ledger rows', async () => {
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true });
      await addLead(w, { contact: w.contact });
      let l = await run(w, nativeCall(w));
      expect(new Set(await reasons(w))).toEqual(new Set(['quarantined:ambiguous_lead']));
      expect([l.intent.length, l.activity.length, l.attempt.length]).toEqual([0, 0, 0]);

      const w2 = await world(db, { flag: true });
      await addLead(w2, { phone: '816-555-0142' });
      l = await run(w2, nativeCall(w2));
      expect(new Set(await reasons(w2))).toEqual(new Set(['quarantined:ambiguous_lead']));
      expect(l.intent).toHaveLength(0);
    });
  });

  it('4. none: no_lead_match for non-US, another rep\'s lead, closed or dead lead, archived queue row', async () => {
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true });
      let l = await run(w, nativeCall(w, { number: '+442079460958', callId: '6543210987654321011' }));
      expect(l.intent).toHaveLength(0);
      l = await run(w, nativeCall(w, { number: '+18165559876', callId: '6543210987654321012', offset: 100_000 }));
      expect(l.intent).toHaveLength(0);
      expect((await reasons(w)).every((r) => r === 'quarantined:no_lead_match')).toBe(true);

      const w2 = await world(db, { flag: true });
      await service(db, () => db.query('update public.properties set assigned_user_id=$1 where id=$2', [w2.rep2, w2.property]));
      expect((await run(w2, nativeCall(w2))).intent).toHaveLength(0); // rep (A) no longer owns it
      expect(new Set(await reasons(w2))).toEqual(new Set(['quarantined:no_lead_match']));

      for (const status of ['closed', 'dead']) {
        const w3 = await world(db, { flag: true });
        await service(db, () => db.query('update public.properties set status=$1 where id=$2', [status, w3.property]));
        expect((await run(w3, nativeCall(w3))).intent).toHaveLength(0);
      }

      const w4 = await world(db, { flag: true });
      await db.query(
        `insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at,version,archived_at,archived_by,archive_reason)
         values ($1,$2,'contacted',now(),1,now(),$3,'manual')`, [w4.property, w4.org, w4.rep]);
      expect((await run(w4, nativeCall(w4))).intent).toHaveLength(0);
    });
  });

  it('5. inbound: answered makes an activity and no attempt, no clock or stage change; missed is no_answer', async () => {
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true });
      const l = await run(w, nativeCall(w, { direction: 'inbound' }));
      expect(l.intent[0]).toMatchObject({ origin: 'native', direction: 'inbound' });
      expect(l.activity).toHaveLength(1);
      expect(l.activity[0]).toMatchObject({ direction: 'inbound', jitter_attempt_id: `dialpad-native:${CALL}` });
      expect(l.attempt).toHaveLength(0);
      expect((await episode(w)).first_call_started_at).toBeNull();
      expect(await stage(w)).toBeNull();

      const w2 = await world(db, { flag: true });
      const m = await run(w2, nativeCall(w2, { direction: 'inbound', answered: false }));
      expect(m.activity[0]).toMatchObject({ direction: 'inbound', outcome: 'no_answer' });
      expect(m.attempt).toHaveLength(0);
    });
  });

  describe('6. DNC', () => {
    const variants: [string, (w: World) => Promise<void>][] = [
      ['contact do_not_contact', async (w) => { await w.db.query('update public.contacts set do_not_contact=true where id=$1', [w.contact]); }],
      ['property is_dnc_locked', async (w) => { await service(w.db, () => w.db.query('update public.properties set is_dnc_locked=true where id=$1', [w.property])); }],
      ['global registry entry', async (w) => {
        await w.db.query(
          `insert into public.global_phone_dnc_registry(org_id,phone_e164,first_consumer_id,first_source_event_id,first_evidence_sha256)
           values ($1,'+18165550142',$2,'evt-1',repeat('a',64))`, [w.org, randomUUID()]);
      }],
    ];
    for (const [name, mark] of variants) {
      for (const direction of ['outbound', 'inbound'] as const) {
        it(`${name} -> dnc_number (${direction}), no ledger rows`, async () => {
          await withP2('nativeMatching', async (db) => {
            const w = await world(db, { flag: true });
            await mark(w);
            const l = await run(w, nativeCall(w, { direction }));
            expect(new Set(await reasons(w))).toEqual(new Set(['quarantined:dnc_number']));
            expect([l.intent.length, l.activity.length, l.attempt.length]).toEqual([0, 0, 0]);
          });
        });
      }
    }
    it('a live plus a DNC candidate binds the live one', async () => {
      await withP2('nativeMatching', async (db) => {
        const w = await world(db, { flag: true });
        await db.query('update public.contacts set do_not_contact=true where id=$1', [w.contact]);
        const live = await addLead(w, { phone: '816-555-0142' });
        const l = await run(w, nativeCall(w));
        expect(l.intent).toHaveLength(1);
        expect(l.intent[0].property_id).toBe(live.property);
      });
    });
  });

  it('7. training property: internal_training activity with null links, no attempt, no episode effect', async () => {
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true, training: true });
      const l = await run(w, nativeCall(w));
      expect(l.activity).toHaveLength(1);
      expect(l.activity[0]).toMatchObject({ call_purpose: 'internal_training', property_id: null, contact_id: null });
      expect(l.attempt).toHaveLength(0);
      expect((await episode(w))?.first_call_started_at ?? null).toBeNull();
    });
  });

  describe('8. no usable rep', () => {
    it('unbound, revoked, inactive, acquisitions off, my leads off: no_binding', async () => {
      await withP2('nativeMatching', async (db) => {
        const w = await world(db, { flag: true });
        expect((await run(w, nativeCall(w, { target: '5159999999999999', callId: '6543210987654321021' }))).intent).toHaveLength(0);
        await db.query("update public.dialpad_member_bindings set status='revoked', revoked_at=now(), revoked_reason='t' where org_id=$1 and user_id=$2", [w.org, w.rep]);
        expect((await run(w, nativeCall(w, { callId: '6543210987654321022', offset: 100_000 }))).intent).toHaveLength(0);
        expect((await reasons(w)).every((r) => r === 'quarantined:no_binding')).toBe(true);
      });
      await withP2('nativeMatching', async (db) => {
        const w = await world(db, { flag: true });
        await db.query("update public.memberships set access_status='suspended' where org_id=$1 and user_id=$2", [w.org, w.rep]).catch(() => undefined);
        const active = (await db.query('select public.dialpad_cti_member_is_active($1,$2) a', [w.org, w.rep])).rows[0].a;
        if (!active) {
          expect((await run(w, nativeCall(w))).intent).toHaveLength(0);
          expect(new Set(await reasons(w))).toEqual(new Set(['quarantined:no_binding']));
        }
      });
      await withP2('nativeMatching', async (db) => {
        const w = await world(db, { flag: true });
        await db.query('update public.acquisition_org_settings set my_leads_enabled=false where org_id=$1', [w.org]);
        expect((await run(w, nativeCall(w))).intent).toHaveLength(0);
        expect(new Set(await reasons(w))).toEqual(new Set(['quarantined:no_binding']));
      });
      await withP2('nativeMatching', async (db) => {
        const w = await world(db, { flag: true });
        await service(db, async () => {
          await db.query("select set_config('my_leads.designation_update', format(':%s:%s', $1::text, $2::text), true)", [w.org, w.rep]);
          await db.query('update public.memberships set acquisitions_enabled=false where org_id=$1 and user_id=$2', [w.org, w.rep]);
        }).catch(() => undefined);
        const on = (await db.query('select acquisitions_enabled a from public.memberships where org_id=$1 and user_id=$2', [w.org, w.rep])).rows[0].a;
        if (!on) {
          expect((await run(w, nativeCall(w))).intent).toHaveLength(0);
          expect(new Set(await reasons(w))).toEqual(new Set(['quarantined:no_binding']));
        }
      });
    });
  });

  it('9. unknown custom_data stays unknown_custom_data; a Sandra-dialed call that lost custom_data binds the open authorized intent', async () => {
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true });
      await run(w, nativeCall(w).map((e) => ({ ...e, custom: 'sandra.dialpad.v1.' + 'f'.repeat(48) })));
      expect(new Set(await reasons(w))).toEqual(new Set(['quarantined:unknown_custom_data']));
      expect((await ledger(w)).intent).toHaveLength(0);
    });
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true });
      const i = await prepare(w);
      await db.query("update public.dialpad_call_intents set dispatch_authorized_at = now() where id=$1", [i.intentId]);
      const l = await run(w, nativeCall(w));
      expect(l.intent).toHaveLength(1); // no synthetic intent
      expect(l.intent[0]).toMatchObject({ id: i.intentId, origin: 'sandra', status: 'matched' });
      expect(l.attempt).toHaveLength(1);
      expect(l.attempt[0].provider_attempt_key).toBe(`dialpad-cti:${i.intentId}`);
    });
  });

  it('9b. two open authorized intents for the same number fall through to native candidates', async () => {
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true });
      const a = await prepare(w);
      const b = await prepare(w);
      for (const i of [a, b]) await db.query('update public.dialpad_call_intents set dispatch_authorized_at = now() where id=$1', [i.intentId]);
      const l = await run(w, nativeCall(w));
      const native = l.intent.filter((i) => i.origin === 'native');
      expect(native).toHaveLength(1);
      expect(l.attempt[0].provider_attempt_key).toBe(`dialpad-native:${CALL}`);
    });
  });

  it('10. a transfer leg links to the same intent; a leg before its root stays quarantined, then resolves', async () => {
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true });
      const start = w.now + 1000;
      await deliver(w, { state: 'calling', at: start, extra: { date_started: start } });
      await deliver(w, { state: 'hangup', at: start + 30_000, extra: { date_started: start, date_connected: start + 3000, date_ended: start + 30_000, talk_time: 27_000, is_transferred: true } });
      const s2 = start + 31_000;
      await deliver(w, { callId: LEG, master: CALL, state: 'connected', at: s2 + 1000, extra: { date_started: s2, date_connected: s2 + 1000 } });
      await deliver(w, { callId: LEG, master: CALL, state: 'hangup', at: s2 + 40_000, extra: { date_started: s2, date_connected: s2 + 1000, date_ended: s2 + 40_000, talk_time: 39_000 } });
      const l = await ledger(w);
      expect(l.intent).toHaveLength(1);
      expect(l.attempt).toHaveLength(1);
      expect(l.activity).toHaveLength(1);
      expect(l.activity[0].ended_at).not.toBeNull();
      expect(new Set(await reasons(w))).toEqual(new Set(['matched:']));
    });
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true });
      const start = w.now + 1000;
      const legId = await ingest(w, { callId: LEG, master: CALL, state: 'connected', at: start + 5000, extra: { date_started: start + 4000, date_connected: start + 5000 } });
      await processEvent(w, legId);
      expect((await reasons(w))[0]).toBe('quarantined:no_custom_data');
      await deliver(w, { state: 'calling', at: start, extra: { date_started: start } });
      const l = await ledger(w);
      expect(new Set(await reasons(w))).toEqual(new Set(['matched:']));
      expect(l.intent).toHaveLength(1);
    });
  });

  it('10b. the intent window opens at the root event: transfer legs arriving >5 s after the root, all stamped before now(), still project', async () => {
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true });
      const start = w.now - 7_200_000; // the call happened two hours before it is processed
      await deliver(w, { state: 'calling', at: start, extra: { date_started: start } });
      await deliver(w, { state: 'hangup', at: start + 30_000, extra: { date_started: start, date_connected: start + 3000, date_ended: start + 30_000, talk_time: 27_000, is_transferred: true } });
      const s2 = start + 31_000;
      await deliver(w, { callId: LEG, master: CALL, state: 'connected', at: s2 + 1000, extra: { date_started: s2, date_connected: s2 + 1000 } });
      await deliver(w, { callId: LEG, master: CALL, state: 'hangup', at: s2 + 40_000, extra: { date_started: s2, date_connected: s2 + 1000, date_ended: s2 + 40_000, talk_time: 39_000 } });
      const l = await ledger(w);
      expect(l.intent).toHaveLength(1);
      expect(new Date(l.intent[0].prepared_at).getTime()).toBe(start); // root event time, not bind time
      expect(new Set(await reasons(w))).toEqual(new Set(['matched:']));
    });
  });

  it('11. reassignment mid-call: the attempt stays with the rep who took the call, the new owner is untouched', async () => {
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true });
      // The call happened an hour ago, inside an episode that started two hours ago.
      await db.query("update public.acquisition_assignment_episodes set assigned_at = now() - interval '2 hours' where property_id=$1", [w.property]);
      w.now = Date.now() - 3_600_000;
      const [calling, connected, hangup] = nativeCall(w);
      await deliver(w, calling!);
      await service(db, () => db.query('update public.properties set assigned_user_id=$1 where id=$2', [w.rep2, w.property]));
      await deliver(w, connected!);
      await deliver(w, hangup!);
      const l = await ledger(w);
      expect(l.attempt).toHaveLength(1);
      expect(l.attempt[0].actor_user_id).toBe(w.rep);
      const eps = (await db.query('select assignee_user_id, first_call_started_at from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null', [w.property])).rows;
      expect(eps).toHaveLength(1);
      expect(eps[0]).toMatchObject({ assignee_user_id: w.rep2, first_call_started_at: null });
    });
  });

  it('13. replay safety: processing twice and through the sweep changes nothing', async () => {
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true });
      const evs = nativeCall(w);
      const ids: string[] = [];
      for (const e of evs) { const id = await ingest(w, e); ids.push(id); await processEvent(w, id); }
      const before = await ledger(w);
      const enteredAt = (await db.query('select stage_entered_at from public.acquisition_queue_states where property_id=$1', [w.property])).rows[0].stage_entered_at;
      const firstCall = (await episode(w)).first_call_started_at;
      for (const id of ids) await processEvent(w, id);
      const pending = (await service(db, () => db.query('select public.fn_list_dialpad_call_events_for_processing(50) as v'))).rows[0].v;
      expect(pending).toEqual([]);
      const after = await ledger(w);
      expect([after.intent.length, after.activity.length, after.attempt.length]).toEqual([1, 1, 1]);
      expect(after.attempt[0].id).toBe(before.attempt[0].id);
      expect((await db.query('select stage_entered_at from public.acquisition_queue_states where property_id=$1', [w.property])).rows[0].stage_entered_at).toEqual(enteredAt);
      expect((await episode(w)).first_call_started_at).toEqual(firstCall);
    });
  });

  it('14. a quarantined no_lead_match or ambiguous_lead event is not picked up by the processing sweep', async () => {
    await withP2('nativeMatching', async (db) => {
      const w = await world(db, { flag: true });
      await run(w, nativeCall(w, { number: '+18165559876' }));
      const pending = (await service(db, () => db.query('select public.fn_list_dialpad_call_events_for_processing(50) as v'))).rows[0].v;
      expect(pending).toEqual([]);
    });
  });

  it('the native helpers are not callable by browser roles', async () => {
    await withP2('nativeMatching', async (db) => {
      for (const sql of [
        'select public.dialpad_cti_native_resolve(gen_random_uuid())',
        'select public.dialpad_cti_resolve_event(gen_random_uuid())',
        'select * from public.dialpad_cti_native_candidates(gen_random_uuid(), gen_random_uuid(), $$8165550142$$)',
      ]) {
        for (const role of ['authenticated', 'anon', 'service_role']) {
          await db.query(`set local role ${role}`);
          expect((await failure(db, () => db.query(sql))).code).toBe('42501');
          await db.query('reset role');
        }
      }
    });
  });
});
void REP_DIALPAD; void REP2_DIALPAD;
