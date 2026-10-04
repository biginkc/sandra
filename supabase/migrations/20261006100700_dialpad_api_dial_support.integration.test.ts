import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { stripTransaction } from '@tests/integration/my-leads-housekeeping-fixture';
import { addLead, asUser, failure, prepare, service, withP2, world, type Json, type World } from '@tests/integration/dialpad-p2-fixture';

const MIGRATION = 'migrations/20261006100700_dialpad_api_dial_support.sql';
const ROLLBACK = 'rollbacks/20261006100700_dialpad_api_dial_support.sql';

const authorize = async (w: World, intentId: string, rep = w.rep): Promise<Json> =>
  (await service(w.db, () => w.db.query('select public.fn_authorize_dialpad_dispatch($1,$2,$3) as v', [w.org, rep, intentId]))).rows[0].v;
const def = async (w: World, sig: string): Promise<string> =>
  (await w.db.query('select pg_get_functiondef($1::regprocedure) as d', [sig])).rows[0].d;
const slots = async (w: World, property = w.property, contact = w.contact): Promise<Json> =>
  (await service(w.db, () => w.db.query('select public.fn_dialpad_call_slots($1,$2,$3,$4) as v', [w.org, w.rep, property, contact]))).rows[0].v;
const PREPARE = 'public.fn_prepare_dialpad_call_intent(uuid,uuid,uuid,uuid,smallint,uuid,uuid,integer)';
const AUTHORIZE = 'public.fn_authorize_dialpad_dispatch(uuid,uuid,uuid)';

describe('20261006100700 dialpad api dial support', () => {
  it('a reassigned lead (open episode, eligible=false, right assignee) can be prepared and authorized', async () => {
    await withP2('apiDial', async (db) => {
      const w = await world(db);
      const changed = await db.query('update public.acquisition_assignment_episodes set eligible=false where org_id=$1 and property_id=$2 and ended_at is null returning id', [w.org, w.property]);
      expect(changed.rowCount).toBe(1);
      const intent = await prepare(w);
      expect(intent.status).toBe('prepared');
      const out = await authorize(w, intent.intentId);
      expect(out.status).toBe('authorized');
      expect(out.dial).toMatchObject({ dialpadUserId: '5150000000000001', phoneNumber: '+18165550142', customData: intent.customData, outboundCallerId: null, identityType: null, identityId: null });
      // Same key again: already dispatched, never a second release.
      expect((await authorize(w, intent.intentId)).status).toBe('already_dispatched');
    });
  });

  it('still refuses a missing or ended episode and another assignee', async () => {
    await withP2('apiDial', async (db) => {
      const w = await world(db);
      // Another assignee on the episode while properties.assigned_user_id stays: denied at prepare.
      await db.query('update public.acquisition_assignment_episodes set assignee_user_id=$3 where org_id=$1 and property_id=$2 and ended_at is null', [w.org, w.property, w.rep2]);
      const other = await failure(db, () => prepare(w));
      expect(other.code).toBe('42501');
      expect((other as Json).detail ?? other.message).toContain('not_assigned_rep');
      await db.query('update public.acquisition_assignment_episodes set assignee_user_id=$3 where org_id=$1 and property_id=$2 and ended_at is null', [w.org, w.property, w.rep]);

      // Episode ended between prepare and authorize: denied at authorize, intent cancelled.
      const intent = await prepare(w);
      await db.query('update public.acquisition_assignment_episodes set ended_at=clock_timestamp() where org_id=$1 and property_id=$2 and ended_at is null', [w.org, w.property]);
      const out = await authorize(w, intent.intentId);
      expect(out).toMatchObject({ status: 'denied', denial: 'not_assigned_rep' });
      expect((await db.query('select status from public.dialpad_call_intents where id=$1', [intent.intentId])).rows[0].status).toBe('cancelled');
      // No open episode at all: prepare refused.
      const none = await failure(db, () => prepare(w));
      expect(none.code).toBe('42501');
    });
  });

  it('neither dial function reads the eligibility flag any more, and the patch is idempotent', async () => {
    await withP2('apiDial', async (db) => {
      const w = await world(db);
      for (const sig of [PREPARE, AUTHORIZE]) expect(await def(w, sig)).not.toContain('eligible');
      const before = [await def(w, PREPARE), await def(w, AUTHORIZE)];
      await db.query(stripTransaction(MIGRATION));
      expect([await def(w, PREPARE), await def(w, AUTHORIZE)]).toEqual(before);
      expect((await def(w, AUTHORIZE)).match(/dialpadUserId/g)).toHaveLength(1);
    });
  });

  it('rollback restores both eligibility checks and drops the columns; re-apply patches again', async () => {
    await withP2('apiDial', async (db) => {
      const w = await world(db);
      await db.query(stripTransaction(ROLLBACK));
      expect(await def(w, PREPARE)).toContain('or not v_episode.eligible');
      expect(await def(w, AUTHORIZE)).toContain('or not v_episode.eligible');
      expect(await def(w, AUTHORIZE)).not.toContain('dialpadUserId');
      const cols = await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='dialpad_org_connections' and column_name in ('dial_endpoint','dial_api_key_ref')");
      expect(cols.rows).toEqual([]);
      await db.query(stripTransaction(MIGRATION));
      for (const sig of [PREPARE, AUTHORIZE]) expect(await def(w, sig)).not.toContain('eligible');
    });
  });

  it('connection columns default to initiate_call, reject bad values, and stay service-only', async () => {
    await withP2('apiDial', async (db) => {
      const w = await world(db);
      const row = await db.query('select dial_endpoint, dial_api_key_ref from public.dialpad_org_connections where id=$1', [w.conn]);
      expect(row.rows[0]).toEqual({ dial_endpoint: 'initiate_call', dial_api_key_ref: null });
      expect((await failure(db, () => db.query("update public.dialpad_org_connections set dial_endpoint='ring' where id=$1", [w.conn]))).code).toBe('23514');
      expect((await failure(db, () => db.query("update public.dialpad_org_connections set dial_api_key_ref='env:DIALPAD_CTI_DIRECTORY_KEY_BMH' where id=$1", [w.conn]))).code).toBe('23514');
      await db.query("update public.dialpad_org_connections set dial_endpoint='call', dial_api_key_ref='env:DIALPAD_CTI_DIAL_KEY_BMH' where id=$1", [w.conn]);
      const denied = await failure(db, () => asUser(db, w.rep, () => db.query('select dial_endpoint from public.dialpad_org_connections where id=$1', [w.conn])));
      expect(denied.code).toBe('42501');
      // The pre-existing column grant still works for the browser role.
      await asUser(db, w.rep, () => db.query('select id, status from public.dialpad_org_connections where id=$1', [w.conn]));
    });
  });

  it('fn_dialpad_call_slots flags every reason and is service-only', async () => {
    await withP2('apiDial', async (db) => {
      const w = await world(db);
      await db.query("update public.contacts set phone_2='555', phone_2_type='mobile', phone_3='(816) 555-0188', phone_3_type='mobile' where id=$1", [w.contact]);
      expect(await slots(w)).toEqual([
        { slot: 1, callable: true, reason: null }, { slot: 2, callable: false, reason: 'invalid' }, { slot: 3, callable: true, reason: null }]);
      await db.query("insert into public.global_phone_dnc_registry(org_id,phone_e164,first_consumer_id,first_source_event_id,first_evidence_sha256) values ($1,'+18165550188',gen_random_uuid(),'evt-a',repeat('a',64))", [w.org]);
      expect((await slots(w))[2]).toEqual({ slot: 3, callable: false, reason: 'phone_dnc' });
      // Contact DNC also locks the property (existing trigger); the property lock is reported first.
      await db.query('update public.contacts set do_not_contact=true where id=$1', [w.contact]);
      expect((await slots(w)).map((s: Json) => s.reason)).toEqual(['property_dnc', 'property_dnc', 'property_dnc']);
      // A contact flagged DNC without the property lock reports contact_dnc.
      const flagged = await addLead(w, { phone: '(816) 555-0155' });
      await db.query('alter table public.contacts disable trigger user');
      await db.query('update public.contacts set do_not_contact=true where id=$1', [flagged.contact]);
      await db.query('alter table public.contacts enable trigger user');
      expect((await slots(w, flagged.property, flagged.contact)).map((s: Json) => s.reason)).toEqual(['contact_dnc', 'contact_dnc', 'contact_dnc']);
      const other = await addLead(w, { phone: '(816) 555-0101' });
      expect(await slots(w, other.property, other.contact)).toEqual([
        { slot: 1, callable: true, reason: null }, { slot: 2, callable: false, reason: 'invalid' }, { slot: 3, callable: false, reason: 'invalid' }]);
      expect((await failure(db, () => asUser(db, w.rep, () => db.query('select public.fn_dialpad_call_slots($1,$2,$3,$4)', [w.org, w.rep, w.property, w.contact])))).code).toBe('42501');
      expect((await failure(db, () => slots(w, randomUUID(), w.contact))).code).toBe('P0002');
    });
  });

  it('a number added to the DNC registry between prepare and authorize cancels the intent (phone_dnc)', async () => {
    await withP2('apiDial', async (db) => {
      const w = await world(db);
      const intent = await prepare(w);
      await db.query("insert into public.global_phone_dnc_registry(org_id,phone_e164,first_consumer_id,first_source_event_id,first_evidence_sha256) values ($1,'+18165550142',gen_random_uuid(),'evt-b',repeat('b',64))", [w.org]);
      expect(await authorize(w, intent.intentId)).toMatchObject({ status: 'denied', denial: 'phone_dnc' });
      expect((await db.query('select status from public.dialpad_call_intents where id=$1', [intent.intentId])).rows[0].status).toBe('cancelled');
      expect((await authorize(w, intent.intentId)).status).toBe('cancelled');
    });
  });
});
