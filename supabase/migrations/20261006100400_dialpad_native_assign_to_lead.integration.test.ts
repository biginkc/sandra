import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { as, asUser, CALL, addLead, deliver, failure, ledger, nativeCall, withP2, world, type Json, type World } from '@tests/integration/dialpad-p2-fixture';

const assign = (w: World, user: string, call: string, property: string): Promise<Json> =>
  asUser(w.db, user, async () => (await w.db.query('select public.fn_assign_native_call_to_lead($1,$2,$3) as v', [w.org, call, property])).rows[0].v);
const list = (w: World, user: string): Promise<Json[]> =>
  asUser(w.db, user, async () => (await w.db.query('select public.fn_list_ambiguous_native_calls($1) as v', [w.org])).rows[0].v);
// Two leads with the same number for rep A, and the first two events of a call to it.
async function ambiguous(db: World['db']) {
  const w = await world(db, { flag: true });
  const other = await addLead(w, { phone: '816-555-0142' });
  const [calling, connected, hangup] = nativeCall(w);
  await deliver(w, calling!);
  await deliver(w, connected!);
  return { w, other, hangup: hangup! };
}

describe('20261006100400 assign to lead', () => {
  it('lists the caller\'s own unresolved ambiguous calls with live candidates', async () => {
    await withP2('assignToLead', async (db) => {
      const { w, other } = await ambiguous(db);
      const mine = await list(w, w.rep);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ providerCallId: CALL, direction: 'outbound', numberLast4: '0142' });
      expect(mine[0].candidates.map((c: Json) => c.propertyId).sort()).toEqual([w.property, other.property].sort());
      expect(mine[0].candidates[0]).toHaveProperty('address');
      expect(await list(w, w.rep2)).toEqual([]);
      // a candidate that becomes DNC disappears from the live list
      await db.query('update public.contacts set do_not_contact=true where id=$1', [other.contact]);
      expect((await list(w, w.rep))[0].candidates.map((c: Json) => c.propertyId)).toEqual([w.property]);
    });
  });

  it('excludes no_lead_match calls', async () => {
    await withP2('assignToLead', async (db) => {
      const w = await world(db, { flag: true });
      for (const e of nativeCall(w, { number: '+18165559876' })) await deliver(w, e);
      expect(await list(w, w.rep)).toEqual([]);
    });
  });

  it('assign picks A: one intent, one attempt, earlier events matched, later events attach', async () => {
    await withP2('assignToLead', async (db) => {
      const { w, other, hangup } = await ambiguous(db);
      const out = await assign(w, w.rep, CALL, other.property);
      expect(out.status).toBe('assigned');
      let l = await ledger(w);
      expect(l.intent).toHaveLength(1);
      expect(l.intent[0]).toMatchObject({ origin: 'native', property_id: other.property, rep_user_id: w.rep });
      expect(l.attempt).toHaveLength(1);
      expect(l.attempt[0]).toMatchObject({ property_id: other.property, provider_attempt_key: `dialpad-native:${CALL}` });
      expect(l.activity).toHaveLength(1);
      expect(out).toMatchObject({ intentId: l.intent[0].id, attemptId: l.attempt[0].id, callActivityId: l.activity[0].id });
      expect(new Set(l.event.map((e) => e.disposition))).toEqual(new Set(['matched']));
      await deliver(w, hangup);
      l = await ledger(w);
      expect([l.intent.length, l.activity.length, l.attempt.length]).toEqual([1, 1, 1]);
      expect(l.activity[0].ended_at).not.toBeNull();
      expect(await list(w, w.rep)).toEqual([]);
    });
  });

  it('a lost-response replay returns already_assigned with the same ids, never P0002', async () => {
    await withP2('assignToLead', async (db) => {
      const { w, other } = await ambiguous(db);
      const first = await assign(w, w.rep, CALL, other.property);
      const again = await assign(w, w.rep, CALL, other.property);
      expect(again).toMatchObject({ status: 'already_assigned', intentId: first.intentId, attemptId: first.attemptId, callActivityId: first.callActivityId });
      expect((await ledger(w)).intent).toHaveLength(1);
      expect((await ledger(w)).attempt).toHaveLength(1);
    });
  });

  it('a different lead for an already assigned call is the non-retryable MLS01 conflict', async () => {
    await withP2('assignToLead', async (db) => {
      const { w, other } = await ambiguous(db);
      await assign(w, w.rep, CALL, other.property);
      expect((await failure(db, () => assign(w, w.rep, CALL, w.property))).code).toBe('MLS01');
    });
  });

  it('refuses a non-candidate, a reassigned or DNC lead, another user\'s call, anonymous callers and bad input', async () => {
    await withP2('assignToLead', async (db) => {
      const { w, other } = await ambiguous(db);
      expect((await failure(db, () => assign(w, w.rep, CALL, randomUUID()))).code).toBe('42501');
      // another rep: has a binding, but the call targets rep A
      expect((await failure(db, () => assign(w, w.rep2, CALL, other.property))).code).toBe('P0002');
      expect((await failure(db, () => assign(w, w.rep, '6543210987654329999', other.property))).code).toBe('P0002');
      expect((await failure(db, () => assign(w, w.rep, 'abc', other.property))).code).toBe('22023');
      await db.query('set local role service_role');
      expect((await failure(db, () => db.query('select public.fn_assign_native_call_to_lead($1,$2,$3)', [w.org, CALL, other.property]))).code).toBe('42501');
      await db.query('reset role');
      await db.query('set local role anon');
      expect((await failure(db, () => db.query('select public.fn_assign_native_call_to_lead($1,$2,$3)', [w.org, CALL, other.property]))).code).toBe('42501');
      await db.query('reset role');
      await as(db, 'authenticated', null, async () => {
        expect((await failure(db, () => db.query('select public.fn_list_ambiguous_native_calls($1)', [w.org]))).code).toBe('42501');
      });
      await db.query('update public.contacts set do_not_contact=true where id=$1', [other.contact]);
      expect((await failure(db, () => assign(w, w.rep, CALL, other.property))).code).toBe('42501');
    });
  });

  it('refuses a property reassigned to someone else after listing', async () => {
    await withP2('assignToLead', async (db) => {
      const { w, other } = await ambiguous(db);
      await db.query('update public.properties set assigned_user_id=$1 where id=$2', [w.rep2, other.property]);
      expect((await failure(db, () => assign(w, w.rep, CALL, other.property))).code).toBe('42501');
    });
  });

  it('assigning the call to a lead with no first call yet applies the first-attempt effects once', async () => {
    await withP2('assignToLead', async (db) => {
      const { w, other } = await ambiguous(db);
      await assign(w, w.rep, CALL, other.property);
      const ep = (await db.query('select first_call_started_at from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null', [other.property])).rows[0];
      expect(ep.first_call_started_at).not.toBeNull();
      const untouched = (await db.query('select first_call_started_at from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null', [w.property])).rows[0];
      expect(untouched.first_call_started_at).toBeNull();
    });
  });
});
