import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { readSql, stripTransaction } from '@tests/integration/my-leads-housekeeping-fixture';
import { CALL, ledger, prepare, withP2, world, deliver, type Ev, type Json, type World } from '@tests/integration/dialpad-p2-fixture';

// Real Dialpad shape (values redacted): the operator (user) leg carries
// {"OAuthApp:<client-id>": "sandra.dialpad.v1.<48hex>"}; the office leg carries no custom_data at all.
const MIGRATION = 'migrations/20261008110000_dialpad_cti_custom_data_oauthapp.sql';
const ROLLBACK = 'rollbacks/20261008110000_dialpad_cti_custom_data_oauthapp.sql';
const OFFICE_CALL = '6543210987654321555';
const HEX48 = 'a'.repeat(48);
const oauth = (token: string, key = 'OAuthApp:client_p2'): Json => ({ [key]: token });

async function setup(db: Client): Promise<void> {
  // The chain helper leaves the DB at 'callbacksDue'; apply the new normalizer (idempotent create-or-replace).
  await db.query(stripTransaction(MIGRATION));
}
const normalize = async (db: Client, json: string | null) =>
  (await db.query('select present, value from public.dialpad_cti_custom_data($1::jsonb)', [json])).rows[0];

function operatorLeg(w: World, custom: Json | string, offset = 0): Ev[] {
  const start = w.now + 1000 + offset;
  const common = { callId: CALL, extra: { custom_data: custom, entry_point_call_id: OFFICE_CALL, date_started: start } };
  return [
    { ...common, state: 'calling', at: start },
    { ...common, state: 'connected', at: start + 4000, extra: { ...common.extra, date_connected: start + 4000 } },
    { ...common, state: 'hangup', at: start + 64_000, extra: { ...common.extra, date_connected: start + 4000, date_ended: start + 64_000, talk_time: 60_000, was_recorded: true } },
  ];
}
function officeLeg(w: World, offset = 0): Ev[] {
  const start = w.now + 500 + offset;
  const common = { callId: OFFICE_CALL, target: false, extra: { target: { type: 'office', id: '4040404040404040' }, operator_call_id: CALL } };
  return [
    { ...common, state: 'calling', at: start, extra: { ...common.extra, date_started: start } },
    { ...common, state: 'hangup', at: start + 64_500, extra: { ...common.extra, date_started: start, date_ended: start + 64_500, talk_time: 60_000 } },
  ];
}

describe('20261008110000 Dialpad CTI custom_data OAuthApp wrapper', () => {
  it('normalizer: accepts the OAuthApp wrapper with the exact token format, fails closed on everything else', async () => {
    await withP2('callbacksDue', async (db) => {
      await setup(db);
      const tok = `sandra.dialpad.v1.${HEX48}`;
      expect(await normalize(db, JSON.stringify(oauth(tok)))).toEqual({ present: true, value: tok });
      expect(await normalize(db, JSON.stringify({ open_cti: tok }))).toEqual({ present: true, value: tok });
      expect(await normalize(db, JSON.stringify(tok))).toEqual({ present: true, value: tok });
      for (const absent of [null, 'null', '""']) expect(await normalize(db, absent)).toEqual({ present: false, value: null });
      const bad: unknown[] = [
        { ...oauth(tok), extra: 'x' }, // two keys
        oauth(tok, 'OAuthApp:'), // empty id
        oauth(tok, 'OAuthApp:bad id'), // id outside the connection id shape
        oauth(tok, 'oauthapp:client_p2'), // wrong case prefix
        oauth(tok, 'OAuthApp'), // no id
        oauth(tok, 'App:client_p2'),
        oauth(`sandra.dialpad.v1.${'A'.repeat(48)}`), // upper-case hex
        oauth(`sandra.dialpad.v1.${'a'.repeat(47)}`), // too short
        oauth(`sandra.dialpad.v1.${'a'.repeat(49)}`), // too long
        oauth(`${tok}\n`), // trailing newline
        oauth('sandra.dialpad.v2.' + HEX48),
        oauth(''), oauth(null as unknown as string), oauth(12345 as unknown as string),
        { 'OAuthApp:client_p2': { 'OAuthApp:client_p2': tok } }, // nested
        { 'OAuthApp:client_p2': [tok] }, // array value
        [oauth(tok)], {},
      ];
      for (const shape of bad) expect(await normalize(db, JSON.stringify(shape))).toEqual({ present: true, value: null });
    });
  });

  it('operator leg with the OAuthApp wrapper matches the intent and projects; the office leg stays quarantined as today', async () => {
    await withP2('callbacksDue', async (db) => {
      await setup(db);
      const w = await world(db); // native_matcher flag OFF: the office leg gets the pre-change outcome
      const intent = await prepare(w);
      const results: Json[] = [];
      for (const e of operatorLeg(w, oauth(String(intent.customData)))) results.push(await deliver(w, e));
      expect(results.map((r) => r.disposition)).toEqual(['matched', 'matched', 'matched']);
      expect(results.every((r) => r.intentId === intent.intentId)).toBe(true);
      for (const e of officeLeg(w)) {
        expect(await deliver(w, e)).toMatchObject({ disposition: 'quarantined', reason: 'no_custom_data', projected: false });
      }
      const l = await ledger(w);
      // Matched + hangup on the operator leg alone is enough: one connected call activity with the talk time,
      // one attempt. The office leg adds nothing and loses nothing.
      expect(l.activity).toHaveLength(1);
      expect(l.activity[0]).toMatchObject({ provider_call_id: CALL, operator_user_id: w.rep, talk_duration_seconds: 60, raw_event_count: 3 });
      expect(l.activity[0].ended_at).not.toBeNull();
      expect(l.attempt).toHaveLength(1);
      expect(l.attempt[0]).toMatchObject({ actor_user_id: w.rep, source: 'dialpad' });
      expect(l.intent[0]).toMatchObject({ status: 'matched', matched_provider_call_id: CALL });
      expect(l.event.filter((e: Json) => e.provider_call_id === OFFICE_CALL).every((e: Json) => e.disposition === 'quarantined' && e.disposition_reason === 'no_custom_data')).toBe(true);
    });
  });

  it('a wrapped token that is wrong, malformed or under a bad key is still unknown_custom_data and credits nothing', async () => {
    await withP2('callbacksDue', async (db) => {
      await setup(db);
      const w = await world(db);
      await prepare(w);
      const wrong = `sandra.dialpad.v1.${'e'.repeat(48)}`;
      const shapes = [oauth(wrong), oauth(wrong, 'OAuthApp:'), oauth('sandra.dialpad.v1.short'), { ...oauth(wrong), second: 'x' }];
      let offset = 0;
      for (const custom of shapes) {
        for (const e of operatorLeg(w, custom, (offset += 100_000)).slice(0, 1)) {
          expect(await deliver(w, e)).toMatchObject({ disposition: 'quarantined', reason: 'unknown_custom_data', projected: false });
        }
      }
      const l = await ledger(w);
      expect(l.activity).toHaveLength(0);
      expect(l.attempt).toHaveLength(0);
      expect(l.intent[0]).toMatchObject({ status: 'prepared', matched_provider_call_id: null });
    });
  });

  it('keeps the other org isolated: the same wrapped event matches in its own org and not in another', async () => {
    await withP2('callbacksDue', async (db) => {
      await setup(db);
      const a = await world(db);
      const b = await world(db);
      const intentA = await prepare(a);
      const custom = oauth(String(intentA.customData));
      const [callingB] = operatorLeg(b, custom);
      expect(await deliver(b, callingB!)).toMatchObject({ disposition: 'quarantined', reason: 'unknown_custom_data' });
      const [callingA] = operatorLeg(a, custom);
      expect(await deliver(a, callingA!)).toMatchObject({ disposition: 'matched', intentId: intentA.intentId });
    });
  });

  it('the rollback twin restores the exact prior behavior (OAuthApp wrapper unknown again) and is re-appliable', async () => {
    await withP2('callbacksDue', async (db) => {
      await setup(db);
      const tok = `sandra.dialpad.v1.${HEX48}`;
      await db.query(stripTransaction(ROLLBACK));
      expect(await normalize(db, JSON.stringify(oauth(tok)))).toEqual({ present: true, value: null });
      expect(await normalize(db, JSON.stringify({ open_cti: tok }))).toEqual({ present: true, value: tok });
      expect(await normalize(db, JSON.stringify('plain'))).toEqual({ present: true, value: 'plain' });
      // Same body as the originally applied migration.
      const original = readSql('migrations/20260929200000_dialpad_cti_custom_data.sql');
      const fn = (sql: string) => sql.slice(sql.indexOf('create or replace function public.dialpad_cti_custom_data'), sql.indexOf('$$;') + 3);
      expect(fn(readSql(ROLLBACK))).toBe(fn(original));
      await db.query(stripTransaction(MIGRATION));
      expect(await normalize(db, JSON.stringify(oauth(tok)))).toEqual({ present: true, value: tok });
    });
  });
});
