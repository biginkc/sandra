import { describe, expect, it } from 'vitest';
import { addLead, asUser, deliver, failure, ledger, nativeCall, prepare, service, setFlag, withP2, world, type Json, type World } from '@tests/integration/dialpad-p2-fixture';

// One Sandra-origin (custom_data) ended call on `property`; returns the attempt row.
async function sandraCall(w: World, o: { property?: string; contact?: string; callId?: string; offset?: number; answered?: boolean } = {}): Promise<Json> {
  const intent = await prepare(w, o.property ?? w.property, o.contact ?? w.contact);
  for (const e of nativeCall(w, { callId: o.callId, offset: o.offset, answered: o.answered })) await deliver(w, { ...e, custom: String(intent.customData) });
  const rows = await w.db.query('select * from public.acquisition_attempts where org_id=$1 and provider_attempt_key = $2', [w.org, `dialpad-cti:${intent.intentId}`]);
  return rows.rows[0];
}
const callId = (n: number) => `7${String(n).padStart(18, '0')}`;

const list = async (w: World, uid: string, args: { limit?: number; cursor?: { beforeEnded: string; beforeId: string } | null; horizon?: string } = {}): Promise<Json> =>
  (await asUser(w.db, uid, () => w.db.query(
    'select public.fn_list_unacknowledged_call_prompts($1,$2,$3,$4,$5::interval) as v',
    [w.org, args.limit ?? 20, args.cursor?.beforeEnded ?? null, args.cursor?.beforeId ?? null, args.horizon ?? '14 days']))).rows[0].v;
const ack = async (w: World, uid: string, attempt: string, via = 'skipped'): Promise<Json> =>
  (await asUser(w.db, uid, () => w.db.query('select public.fn_acknowledge_call_prompt($1,$2,$3) as v', [w.org, attempt, via]))).rows[0].v;
const legacy = async (w: World, apply: boolean, fp: string | null = null): Promise<Json> =>
  (await service(w.db, () => w.db.query('select public.fn_my_leads_ack_legacy_call_prompts($1,$2,$3) as v', [w.org, apply, fp]))).rows[0].v;
const rollback = async (w: World, run: string): Promise<Json> => {
  const fp = (await w.db.query('select public.my_leads_housekeeping_rollback_fingerprint($1,$2) as f', [run, w.org])).rows[0].f;
  return (await service(w.db, () => w.db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as v', [run, w.org, fp]))).rows[0].v;
};
const ackState = async (w: World, id: string) =>
  (await w.db.query('select prompt_acknowledged_at, prompt_acknowledged_via, outcome from public.acquisition_attempts where id=$1', [id])).rows[0];

describe('20261006100600 call prompt acknowledgement', () => {
  it('returns only ended, pending, unacknowledged, own, still-assigned, customer ledger attempts from both origins', async () => {
    await withP2('ackPrompts', async (db) => {
      const w = await world(db, { flag: true });
      const sandra = await sandraCall(w, { callId: callId(1) });
      // Native call on a second lead.
      const second = await addLead(w, { phone: '(816) 555-0199' });
      for (const e of nativeCall(w, { callId: callId(2), number: '+18165550199', offset: 5000 })) await deliver(w, e);
      // Inbound native: activity only, never an attempt.
      for (const e of nativeCall(w, { callId: callId(3), direction: 'inbound', offset: 10_000 })) await deliver(w, e);
      // Training lead: internal_training activity, no attempt.
      const trainingContact = (await db.query("insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values (gen_random_uuid(),$1,'T','Train','(816) 555-0177','mobile') returning id", [w.org])).rows[0].id;
      await service(db, () => db.query(
        `insert into public.properties(id,org_id,address,city,state,homeowner_contact_id,assigned_user_id,is_training,status)
         values (gen_random_uuid(),$1,'9 Training Ct','Kansas City','MO',$2,$3,true,'new_lead')`, [w.org, trainingContact, w.rep]));
      for (const e of nativeCall(w, { callId: callId(4), number: '+18165550177', offset: 15_000 })) await deliver(w, e);

      const { attempt } = await ledger(w);
      expect(attempt).toHaveLength(2);
      const nativeAttempt = attempt.find((a: Json) => String(a.provider_attempt_key).startsWith('dialpad-native:'));
      expect(nativeAttempt.property_id).toBe(second.property);

      const page = await list(w, w.rep);
      expect(page.nextCursor).toBeNull();
      expect(page.items.map((i: Json) => i.origin).sort()).toEqual(['native', 'sandra']);
      // Newest first: the native call ended later.
      expect(page.items[0]).toMatchObject({ attemptId: nativeAttempt.id, propertyId: second.property, origin: 'native', outcomeGuess: 'reached', voicemail: false, talkDurationSeconds: 60 });
      expect(page.items[1]).toMatchObject({ attemptId: sandra.id, propertyId: w.property, origin: 'sandra', callActivityId: sandra.call_activity_id });
      expect(typeof page.items[0].endedAt).toBe('string');

      // Another member sees nothing of the rep's calls.
      expect((await list(w, w.rep2)).items).toEqual([]);

      // A saved outcome removes the row (no acknowledgement needed).
      await db.query("update public.acquisition_attempts set outcome='reached' where id=$1", [sandra.id]);
      expect((await list(w, w.rep)).items.map((i: Json) => i.attemptId)).toEqual([nativeAttempt.id]);

      // A lead no longer actionable by the rep (here: soft-deleted) is not offered.
      await service(db, () => db.query('update public.properties set deleted_at = now() where id=$1', [second.property]));
      expect((await list(w, w.rep)).items).toEqual([]);
    });
  });

  it('paginates eight calls three at a time with a keyset cursor', async () => {
    await withP2('ackPrompts', async (db) => {
      const w = await world(db);
      const made: string[] = [];
      // Offsets stay inside the 600 s intent window (a Sandra event outside it is quarantined, by design).
      for (let n = 0; n < 8; n += 1) made.push((await sandraCall(w, { callId: callId(10 + n), offset: n * 30_000 })).id);
      const seen: string[] = [];
      let cursor: Json = null;
      for (let page = 0; page < 3; page += 1) {
        const out = await list(w, w.rep, { limit: 3, cursor });
        seen.push(...out.items.map((i: Json) => i.attemptId));
        cursor = out.nextCursor;
        if (page < 2) expect(cursor).toMatchObject({ beforeEnded: expect.any(String), beforeId: out.items[2].attemptId });
      }
      expect(cursor).toBeNull();
      expect(seen).toHaveLength(8);
      expect(new Set(seen).size).toBe(8);
      expect(seen).toEqual([...made].reverse()); // newest first, oldest last
      // Limit is clamped to 1..50 and a half cursor is refused.
      expect((await list(w, w.rep, { limit: 0 })).items).toHaveLength(1);
      const err = await failure(db, () => asUser(db, w.rep, () => db.query('select public.fn_list_unacknowledged_call_prompts($1,20,now(),null)', [w.org])));
      expect(err.code).toBe('22023');
    });
  });

  it('keeps a call from two days ago and drops one from fifteen days ago', async () => {
    await withP2('ackPrompts', async (db) => {
      // Native calls carry no intent window, so they can be backdated.
      const w = await world(db, { flag: true });
      w.now = Date.now() - 15 * 86_400_000;
      for (const e of nativeCall(w, { callId: callId(20) })) await deliver(w, e);
      w.now = Date.now() - 2 * 86_400_000;
      for (const e of nativeCall(w, { callId: callId(21) })) await deliver(w, e);
      const { attempt } = await ledger(w);
      expect(attempt).toHaveLength(2);
      const byCall = (id: string) => attempt.find((a: Json) => a.provider_attempt_key === `dialpad-native:${id}`).id;
      expect((await list(w, w.rep)).items.map((i: Json) => i.attemptId)).toEqual([byCall(callId(21))]);
      expect((await list(w, w.rep, { horizon: '30 days' })).items.map((i: Json) => i.attemptId)).toEqual([byCall(callId(21)), byCall(callId(20))]);
    });
  });

  it('guesses voicemail and no_answer from the activity', async () => {
    await withP2('ackPrompts', async (db) => {
      const w = await world(db);
      const missed = await sandraCall(w, { callId: callId(30), answered: false });
      expect((await list(w, w.rep)).items[0]).toMatchObject({ attemptId: missed.id, outcomeGuess: 'no_answer', voicemail: false });
      await db.query("update public.call_activities set provider_voicemail_url='https://dialpad.com/vm/1' where id=$1", [missed.call_activity_id]);
      expect((await list(w, w.rep)).items[0]).toMatchObject({ outcomeGuess: 'voicemail', voicemail: true });
    });
  });

  it('acknowledges idempotently, never touches the outcome, and refuses another user', async () => {
    await withP2('ackPrompts', async (db) => {
      const w = await world(db);
      const a = await sandraCall(w, { callId: callId(40) });
      const other = await failure(db, () => ack(w, w.rep2, a.id));
      expect(other.code).toBe('42501');
      expect((await list(w, w.rep)).items).toHaveLength(1);

      const first = await ack(w, w.rep, a.id, 'skipped');
      expect(first).toMatchObject({ status: 'acknowledged', attemptId: a.id, via: 'skipped' });
      const state = await ackState(w, a.id);
      expect(state.prompt_acknowledged_via).toBe('skipped');
      expect(state.outcome).toBeNull(); // the touch still counts; outcome stays pending
      expect((await list(w, w.rep)).items).toEqual([]);

      const again = await ack(w, w.rep, a.id, 'dismissed');
      expect(again).toMatchObject({ status: 'already', via: 'skipped' });
      expect((await ackState(w, a.id)).prompt_acknowledged_at).toEqual(state.prompt_acknowledged_at);

      const bad = await failure(db, () => ack(w, w.rep, a.id, 'closed'));
      expect(bad.code).toBe('22023');
      const anon = await failure(db, async () => {
        await db.query('set local role anon');
        await db.query('select public.fn_list_unacknowledged_call_prompts($1)', [w.org]);
      });
      expect(anon.code).toBe('42501');
      const anonAck = await failure(db, async () => {
        await db.query('set local role anon');
        await db.query("select public.fn_acknowledge_call_prompt($1,$2,'skipped')", [w.org, a.id]);
      });
      expect(anonAck.code).toBe('42501');
    });
  });

  it('legacy acknowledgement previews without writing, applies with a run and before-images, and rolls back', async () => {
    await withP2('ackPrompts', async (db) => {
      const w = await world(db, { flag: true });
      const a = await sandraCall(w, { callId: callId(50) });
      const second = await addLead(w, { phone: '(816) 555-0199' });
      for (const e of nativeCall(w, { callId: callId(51), number: '+18165550199', offset: 5000 })) await deliver(w, e);
      const b = (await ledger(w)).attempt.find((x: Json) => x.property_id === second.property);
      // A Sandra-softphone attempt (no ledger key) must never be touched.
      const softphone = (await db.query(
        `insert into public.acquisition_attempts (org_id, property_id, actor_user_id, attempt_kind, source, occurred_at, idempotency_key, provider_attempt_key)
         values ($1,$2,$3,'call','sandra',now(),gen_random_uuid(),'softphone:legacy-1') returning id`, [w.org, w.property, w.rep])).rows[0].id;

      const preview = await legacy(w, false);
      expect(preview).toMatchObject({ kind: 'ack_legacy_prompts', candidates: 2 });
      expect(preview.sample.sort()).toEqual([a.id, b.id].sort());
      expect((await list(w, w.rep)).items).toHaveLength(2);
      expect((await db.query('select count(*)::int as n from public.my_leads_housekeeping_runs where org_id=$1', [w.org])).rows[0].n).toBe(0);

      const stale = await failure(db, () => legacy(w, true, 'deadbeef'));
      expect(stale.message).toContain('FINGERPRINT_MISMATCH');
      const noFp = await failure(db, () => legacy(w, true, null));
      expect(noFp.message).toContain('FINGERPRINT_REQUIRED');

      const done = await legacy(w, true, preview.fingerprint);
      expect(done).toMatchObject({ acknowledged: 2 });
      expect((await list(w, w.rep)).items).toEqual([]);
      for (const id of [a.id, b.id]) expect((await ackState(w, id)).prompt_acknowledged_via).toBe('dismissed');
      expect((await ackState(w, softphone)).prompt_acknowledged_at).toBeNull();
      const images = await db.query('select table_name, row_id, before from public.my_leads_housekeeping_before_images where run_id=$1 order by row_id', [done.runId]);
      expect(images.rows).toHaveLength(2);
      expect(images.rows[0].before).toMatchObject({ op: 'updated', prompt_acknowledged_at: null, applied_via: 'dismissed' });
      expect(await legacy(w, true, (await legacy(w, false)).fingerprint)).toMatchObject({ noop: true });

      // The rep re-acknowledges one row by hand after the run: it is no longer restorable.
      await db.query("update public.acquisition_attempts set prompt_acknowledged_at = now() + interval '1 second', prompt_acknowledged_via='saved' where id=$1", [b.id]);
      const out = await rollback(w, done.runId);
      expect((await ackState(w, a.id)).prompt_acknowledged_at).toBeNull();
      expect((await ackState(w, b.id)).prompt_acknowledged_via).toBe('saved');
      expect(JSON.stringify(out)).toContain('acknowledgement_changed_since');
      // A partial rollback (one row reported) leaves the run applied, as every other housekeeping kind does.
      expect(out).toMatchObject({ restored: 1, status: 'applied' });
      expect((await list(w, w.rep)).items.map((i: Json) => i.attemptId)).toEqual([a.id]);
    });
  });

  it('a service role cannot call the personal RPCs', async () => {
    await withP2('ackPrompts', async (db) => {
      const w = await world(db);
      const err = await failure(db, () => service(db, () => db.query('select public.fn_list_unacknowledged_call_prompts($1)', [w.org])));
      expect(err.code).toBe('42501');
    });
  });
});
