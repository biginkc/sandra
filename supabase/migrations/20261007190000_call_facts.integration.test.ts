import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { applyMyLeadsChain, chainThrough, stripTransaction } from '@tests/integration/my-leads-housekeeping-fixture';
import { asUser, dbUrl, deliver, failure, ledger, nativeCall, service, setFlag, world, type Json, type World } from '@tests/integration/dialpad-p2-fixture';

// Local-only: every test runs inside one transaction that is rolled back.
async function withFacts(fn: (db: Client) => Promise<void>) {
  const db = new Client({ connectionString: dbUrl() });
  await db.connect();
  try {
    await db.query('begin');
    await applyMyLeadsChain(db, chainThrough('callFacts'));
    await fn(db);
  } finally {
    await db.query('rollback').catch(() => undefined);
    await db.end();
  }
}

const TERMINAL = ['available', 'unavailable', 'denied'];
const setFetch = (w: World, activity: string, artifact: string, state: string) =>
  w.db.query('update public.dialpad_call_artifact_fetches set state=$4 where org_id=$1 and call_activity_id=$2 and artifact=$3', [w.org, activity, artifact, state]);
const putTranscript = (w: World, activity: string, text: string | null, summary: string | null) =>
  w.db.query(`insert into public.call_transcripts (call_activity_id, status, text, summary, summary_status) values ($1,'available',$2,$3,$4)`,
    [activity, text, summary, summary ? 'available' : 'none']);

// An ended, answered customer call on w.property whose artifact rows are fetchable (flags on).
async function call(w: World, o: { facts?: boolean; callId?: string; offset?: number } = {}): Promise<Json> {
  await setFlag(w.db, w.org, 'artifact_fetch', true);
  if (o.facts !== false) await setFlag(w.db, w.org, 'facts_job', true);
  w.now = Date.now() - 3 * 3_600_000;
  for (const e of nativeCall(w, { callId: o.callId, offset: o.offset })) await deliver(w, e);
  const activity = (await ledger(w)).activity.at(-1);
  expect(activity.property_id).toBe(w.property);
  return activity;
}
const ready = async (w: World, a: Json, text = 'Seller: I want 185k for it', summary: string | null = 'Seller wants 185k and must move by spring.') => {
  await putTranscript(w, a.id, text, summary);
  await setFetch(w, a.id, 'transcript', 'available');
  await setFetch(w, a.id, 'recap', 'available');
};
const claim = async (w: World, limit = 10, lease = 300, windowHours = 48): Promise<{ claims: Json[]; exhausted: Json[] }> =>
  (await service(w.db, () => w.db.query('select public.fn_claim_call_facts($1,$2,$3) as v', [limit, lease, windowHours]))).rows[0].v;
const complete = async (w: World, id: string, token: string, facts: Json, status: string, model: string | null = 'm') =>
  (await service(w.db, () => w.db.query('select public.fn_complete_call_facts($1,$2,$3,$4,$5) as v', [id, token, JSON.stringify(facts), status, model]))).rows[0].v;
const factRow = async (w: World, id: string): Promise<Json> => (await w.db.query('select * from public.lead_call_facts where id=$1', [id])).rows[0];
const notes = async (w: World, like = '%') => (await w.db.query('select * from public.lead_notes where org_id=$1 and body like $2 order by created_at', [w.org, like])).rows as Json[];
const FACTS = { asking_price: { value: '$185,000', evidence: 'I want 185k for it' }, motivation: { value: 'must move by spring', evidence: 'must move by spring' } };

describe('20261007190000_call_facts', () => {
  it('claims only when the facts_job flag is on, both artifacts are terminal and at least one is available', async () => {
    await withFacts(async (db) => {
      const off = await world(db, { flag: true });
      const a0 = await call(off, { facts: false });
      await ready(off, a0);
      expect((await claim(off)).claims).toEqual([]); // flag off

      const w = await world(db, { flag: true });
      const a = await call(w);
      await putTranscript(w, a.id, 'Seller: hi', 'sum');
      expect((await claim(w)).claims).toEqual([]); // both pending
      await setFetch(w, a.id, 'transcript', 'available');
      expect((await claim(w)).claims).toEqual([]); // recap still pending
      await setFetch(w, a.id, 'recap', 'flagged');
      expect((await claim(w)).claims).toEqual([]); // flagged is not terminal
      await setFetch(w, a.id, 'transcript', 'unavailable');
      await setFetch(w, a.id, 'recap', 'denied');
      expect((await claim(w)).claims).toEqual([]); // terminal but nothing available
      for (const t of TERMINAL) {
        await setFetch(w, a.id, 'transcript', t);
        await setFetch(w, a.id, 'recap', 'available');
        await db.query('delete from public.lead_call_facts where call_activity_id=$1', [a.id]);
        const got = await claim(w);
        expect(got.claims).toHaveLength(1);
        await db.query('delete from public.lead_call_facts where call_activity_id=$1', [a.id]);
      }
    });
  });

  it('returns summary and transcript from call_transcripts, leases the row, and never double-claims', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await ready(w, a);
      const first = await claim(w);
      expect(first.claims).toHaveLength(1);
      expect(first.claims[0]).toMatchObject({ call_activity_id: a.id, summary: 'Seller wants 185k and must move by spring.', transcript: 'Seller: I want 185k for it' });
      const row = await factRow(w, first.claims[0].fact_id);
      expect(row).toMatchObject({ processing_state: 'claimed', attempts: 1, status: 'proposed' });
      expect((await claim(w)).claims).toEqual([]);
    });
  });

  it('never claims training or soft-deleted leads', async () => {
    await withFacts(async (db) => {
      const t = await world(db, { flag: true, training: true });
      await setFlag(db, t.org, 'artifact_fetch', true);
      await setFlag(db, t.org, 'facts_job', true);
      t.now = Date.now() - 3 * 3_600_000;
      for (const e of nativeCall(t)) await deliver(t, e);
      // A training call projects to an internal_training activity with no property: nothing to claim.
      for (const a of (await ledger(t)).activity) {
        await db.query("update public.dialpad_call_artifact_fetches set state='available' where call_activity_id=$1", [a.id]);
      }
      expect((await claim(t)).claims).toEqual([]);
      const w = await world(db, { flag: true });
      const b = await call(w);
      await ready(w, b);
      await db.query('update public.properties set deleted_at = now() where id=$1', [w.property]);
      expect((await claim(w)).claims).toEqual([]);
    });
  });

  it('crash after reservation: the expired lease is reclaimed with a new token and completes once; the old token is rejected', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await ready(w, a);
      const first = (await claim(w)).claims[0];
      expect(await claim(w)).toEqual({ claims: [], exhausted: [] });
      await db.query("update public.lead_call_facts set lease_until = now() - interval '1 second' where id=$1", [first.fact_id]);
      const second = (await claim(w)).claims[0];
      expect(second.fact_id).toBe(first.fact_id);
      expect(second.claim_token).not.toBe(first.claim_token);
      expect((await factRow(w, first.fact_id)).attempts).toBe(2);
      const stale = await failure(db, () => service(db, () => db.query('select public.fn_complete_call_facts($1,$2,$3,$4,$5)', [first.fact_id, first.claim_token, '{}', 'no_facts', null])));
      expect(stale.message).toContain('CLAIM_TOKEN_MISMATCH');
      const done = await complete(w, second.fact_id, second.claim_token, FACTS, 'proposed');
      expect(done).toMatchObject({ replayed: false, status: 'proposed' });
      expect(await claim(w)).toEqual({ claims: [], exhausted: [] }); // done is never selected
    });
  });

  it('completion creates exactly one summary note and one facts row; a replay is a no-op; an expired lease is rejected', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await ready(w, a);
      const c = (await claim(w)).claims[0];
      await db.query("update public.lead_call_facts set lease_until = now() - interval '1 second' where id=$1", [c.fact_id]);
      const late = await failure(db, () => service(db, () => db.query('select public.fn_complete_call_facts($1,$2,$3,$4,$5)', [c.fact_id, c.claim_token, '{}', 'no_facts', null])));
      expect(late.message).toContain('LEASE_EXPIRED');
      expect(await notes(w, 'Dialpad call summary%')).toHaveLength(0); // nothing visible before commit
      const c2 = (await claim(w)).claims[0];

      const r1 = await complete(w, c2.fact_id, c2.claim_token, FACTS, 'proposed', 'claude-haiku');
      const r2 = await complete(w, c2.fact_id, c2.claim_token, FACTS, 'proposed', 'claude-haiku');
      expect(r2).toMatchObject({ replayed: true, summaryNoteId: r1.summaryNoteId });
      const n = await notes(w, 'Dialpad call summary%');
      expect(n).toHaveLength(1);
      expect(n[0].author_user_id).toBeNull();
      expect(n[0].body).toContain('Seller wants 185k and must move by spring.');
      expect(n[0].idempotency_key).toBe((await db.query("select md5('call_facts_summary:' || $1::text)::uuid as k", [a.id])).rows[0].k);
      const row = await factRow(w, c2.fact_id);
      expect(row).toMatchObject({ processing_state: 'done', status: 'proposed', model: 'claude-haiku', summary_note_id: n[0].id });
      expect(row.facts).toEqual(FACTS);
      expect((await db.query('select count(*)::int c from public.lead_call_facts where call_activity_id=$1', [a.id])).rows[0].c).toBe(1);
    });
  });

  it('crash after note creation: a pre-existing deterministic note is reused, never duplicated', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await ready(w, a);
      const c = (await claim(w)).claims[0];
      // The first worker created the note then died before the facts landed.
      await db.query(`insert into public.lead_notes (org_id, property_id, author_user_id, body, idempotency_key)
        values ($1,$2,null,'Dialpad call summary earlier', md5('call_facts_summary:' || $3::text)::uuid)`, [w.org, w.property, a.id]);
      await db.query("update public.lead_call_facts set lease_until = now() - interval '1 second' where id=$1", [c.fact_id]);
      const c2 = (await claim(w)).claims[0];
      const done = await complete(w, c2.fact_id, c2.claim_token, FACTS, 'proposed');
      expect(await notes(w, 'Dialpad call summary%')).toHaveLength(1);
      expect(done.summaryNoteId).toBe((await notes(w, 'Dialpad call summary%'))[0].id);
    });
  });

  it('no summary: no note; empty facts is no_facts; shape and status are validated', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await ready(w, a, 'Seller: hello', null);
      const c = (await claim(w)).claims[0];
      expect(c.summary).toBeNull();
      for (const bad of [
        [{ bogus: { value: 'x', evidence: 'x' } }, 'proposed'],
        [{ asking_price: { value: 1, evidence: 'x' } }, 'proposed'],
        [{}, 'proposed'],
        [FACTS, 'no_facts'],
      ] as const) {
        const e = await failure(db, () => service(db, () => db.query('select public.fn_complete_call_facts($1,$2,$3,$4,$5)', [c.fact_id, c.claim_token, JSON.stringify(bad[0]), bad[1], null])));
        expect(e.message).toContain('INVALID_INPUT');
      }
      const done = await complete(w, c.fact_id, c.claim_token, {}, 'no_facts', null);
      expect(done).toMatchObject({ status: 'no_facts', summaryNoteId: null });
      expect(await notes(w, 'Dialpad call summary%')).toHaveLength(0);
    });
  });

  it('attempts exhausted: the row is failed once, reported once, and never selected again', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await ready(w, a);
      const c = (await claim(w)).claims[0];
      await db.query("update public.lead_call_facts set attempts = 5, lease_until = now() - interval '1 second' where id=$1", [c.fact_id]);
      const first = await claim(w);
      expect(first.claims).toEqual([]);
      expect(first.exhausted).toEqual([{ fact_id: c.fact_id, call_activity_id: a.id }]);
      expect(await factRow(w, c.fact_id)).toMatchObject({ processing_state: 'failed', claim_token: null });
      expect(await claim(w)).toEqual({ claims: [], exhausted: [] });
    });
  });

  it('only claims calls that ended inside the window (no backlog), newest first, and returns the call time', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await ready(w, a);
      // The call ended about 3 hours ago.
      const c = (await claim(w, 10, 300, 48)).claims;
      expect(c).toHaveLength(1);
      expect(new Date(c[0].ended_at).getTime()).toBe(new Date((await db.query('select coalesce(ended_at, started_at) t from public.call_activities where id=$1', [a.id])).rows[0].t).getTime());
      await db.query('delete from public.lead_call_facts');
      expect((await claim(w, 10, 300, 2)).claims).toEqual([]); // 3h old call, 2h window
      await db.query("update public.call_activities set ended_at = now() - interval '20 days', started_at = now() - interval '20 days' where id=$1", [a.id]);
      expect((await claim(w, 10, 300, 48)).claims).toEqual([]); // a 20-day-old call is history
      expect((await claim(w, 10, 300, 720)).claims).toHaveLength(1); // only a wider window would reach it
    });
  });

  it('limits and lease arguments are validated and the job functions are service-only', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      for (const [l, s] of [[0, 300], [51, 300], [5, 10], [5, 99999]]) {
        const e = await failure(db, () => service(db, () => db.query('select public.fn_claim_call_facts($1,$2,48)', [l, s])));
        expect(e.message).toContain('INVALID_INPUT');
      }
      const badWindow = await failure(db, () => service(db, () => db.query('select public.fn_claim_call_facts(5,300,0)')));
      expect(badWindow.message).toContain('INVALID_INPUT');
      const denied = await failure(db, () => asUser(db, w.rep, () => db.query('select public.fn_claim_call_facts(5,300,48)')));
      expect((denied as { code?: string }).code).toBe('42501');
      const deniedComplete = await failure(db, () => asUser(db, w.rep, () => db.query('select public.fn_complete_call_facts($1,$1,$2,$3,null)', [randomUUID(), '{}', 'no_facts'])));
      expect((deniedComplete as { code?: string }).code).toBe('42501');
    });
  });

  async function done(w: World, facts: Json = FACTS): Promise<{ id: string; activity: Json }> {
    const a = await call(w);
    await ready(w, a);
    const c = (await claim(w)).claims[0];
    await complete(w, c.fact_id, c.claim_token, facts, 'proposed');
    return { id: c.fact_id, activity: a };
  }
  const accept = (w: World, user: string, id: string, field: string, value: string, org = w.org) =>
    asUser(w.db, user, () => w.db.query('select public.fn_accept_call_fact($1,$2,$3,$4) as v', [org, id, field, value]));

  it('accept appends a note authored by the caller, records accepted[field], and is idempotent', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const { id } = await done(w);
      const r = (await accept(w, w.rep, id, 'asking_price', '$185,000')).rows[0].v;
      expect(r).toMatchObject({ duplicate: false, field: 'asking_price', status: 'partially_accepted' });
      const n = await notes(w, 'From call summary - %');
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ body: 'From call summary - Asking price: $185,000', author_user_id: w.rep, property_id: w.property });
      const row = await factRow(w, id);
      expect(row.status).toBe('partially_accepted');
      expect(row.accepted.asking_price).toMatchObject({ value: '$185,000', by: w.rep });
      expect(row.facts).toEqual(FACTS); // the proposal itself is untouched
      expect((await accept(w, w.rep, id, 'asking_price', '$185,000')).rows[0].v.duplicate).toBe(true);
      expect(await notes(w, 'From call summary - %')).toHaveLength(1);
      await accept(w, w.rep, id, 'motivation', 'must move by spring');
      expect(await notes(w, 'From call summary - %')).toHaveLength(2);
    });
  });

  it('accept ignores the client value: the stored proposal value is what is written', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const { id } = await done(w);
      for (const spoof of ['$1', '  ', 'x'.repeat(900)]) {
        await db.query('delete from public.lead_notes where body like $1', ['From call summary - %']);
        await db.query("update public.lead_call_facts set accepted='{}'::jsonb, status='proposed' where id=$1", [id]);
        const r = (await accept(w, w.rep, id, 'asking_price', spoof)).rows[0].v;
        expect(r.duplicate).toBe(false);
        const n = await notes(w, 'From call summary - %');
        expect(n.map((x) => x.body)).toEqual(['From call summary - Asking price: $185,000']);
        expect((await factRow(w, id)).accepted.asking_price.value).toBe('$185,000');
      }
    });
  });

  it('the widened allow-list accepts the pains, the reused Closer Lab questions and objections end to end', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const { id } = await done(w, {
        behind_on_payments: { value: 'we are behind', evidence: 'we are behind' },
        pain_divorce: { value: 'going through a divorce', evidence: 'divorce' },
        objection_think: { value: 'let me think', evidence: 'let me think' },
        not_rushed: { value: 'no rush', evidence: 'no rush' },
      });
      for (const f of ['behind_on_payments', 'pain_divorce', 'objection_think', 'not_rushed']) await accept(w, w.rep, id, f, 'ignored');
      expect((await notes(w, 'From call summary - %')).map((n) => n.body)).toEqual([
        'From call summary - Behind on payments: we are behind',
        'From call summary - Divorce: going through a divorce',
        'From call summary - Decision time: let me think',
        'From call summary - Not rushed: no rush',
      ]);
      const bad = await failure(db, () => service(db, () => db.query('select public.fn_complete_call_facts($1,$2,$3,$4,$5)', [randomUUID(), randomUUID(), JSON.stringify({ objections: { value: 'x', evidence: 'x' } }), 'proposed', null])));
      expect(bad.message).toContain('INVALID_INPUT');
    });
  });

  it('accept writes the VERBATIM value (never derived text) and keeps structured data separate', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const { id } = await done(w, {
        asking_price: { value: '185k', evidence: 'I want 185k', amount_cents: 18500000 },
        next_step: { value: 'next Friday', evidence: 'call me next Friday', due_at: '2099-01-05T20:00:00.000Z' },
      });
      await accept(w, w.rep, id, 'asking_price', '$185,000');
      await accept(w, w.rep, id, 'next_step', '2099-01-05T20:00:00.000Z');
      expect((await notes(w, 'From call summary - %')).map((n) => n.body)).toEqual([
        'From call summary - Asking price: 185k',
        'From call summary - Next step: next Friday',
      ]);
      const row = await factRow(w, id);
      expect(row.accepted.asking_price).toMatchObject({ value: '185k', amount_cents: 18500000 });
      expect(row.accepted.next_step).toMatchObject({ value: 'next Friday', due_at: '2099-01-05T20:00:00.000Z' });
    });
  });

  it('complete only allows value, evidence and the two structured fields, with sane types', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await ready(w, a);
      const c = (await claim(w)).claims[0];
      for (const bad of [
        { asking_price: { value: 'x', evidence: 'x', extra: 1 } },
        { asking_price: { value: 'x', evidence: 'x', amount_cents: -5 } },
        { asking_price: { value: 'x', evidence: 'x', amount_cents: '5' } },
        { next_step: { value: 'x', evidence: 'x', due_at: 5 } },
      ]) {
        const e = await failure(db, () => service(db, () => db.query('select public.fn_complete_call_facts($1,$2,$3,$4,$5)', [c.fact_id, c.claim_token, JSON.stringify(bad), 'proposed', null])));
        expect(e.message).toContain('INVALID_INPUT');
      }
    });
  });

  it('accept, unaccept and dismiss enforce lead ownership in SQL: another rep, an owner who is not assigned, and other orgs are refused', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const { id } = await done(w);
      for (const user of [w.rep2, w.owner]) {
        const e1 = await failure(db, () => accept(w, user, id, 'asking_price', 'x'));
        expect((e1 as { code?: string }).code).toBe('42501');
        const e2 = await failure(db, () => asUser(db, user, () => db.query('select public.fn_dismiss_call_facts($1,$2)', [w.org, id])));
        expect((e2 as { code?: string }).code).toBe('42501');
        const e3 = await failure(db, () => asUser(db, user, () => db.query('select public.fn_unaccept_call_fact($1,$2,$3)', [w.org, id, 'asking_price'])));
        expect((e3 as { code?: string }).code).toBe('42501');
      }
      expect(await notes(w, 'From call summary - %')).toHaveLength(0);
      expect((await factRow(w, id)).status).toBe('proposed');
      // After a reassignment the former assignee is refused too.
      await db.query('update public.properties set assigned_user_id = $1 where id = $2', [w.rep2, w.property]);
      const gone = await failure(db, () => accept(w, w.rep, id, 'asking_price', 'x'));
      expect((gone as { code?: string }).code).toBe('42501');
    });
  });

  it('unaccept removes the acceptance and its note so the chip returns; a dismissed fact cannot be accepted afterwards', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const { id } = await done(w);
      await accept(w, w.rep, id, 'asking_price', 'x');
      expect(await notes(w, 'From call summary - %')).toHaveLength(1);
      const r = (await asUser(db, w.rep, () => db.query('select public.fn_unaccept_call_fact($1,$2,$3) as v', [w.org, id, 'asking_price']))).rows[0].v;
      expect(r).toEqual({ reverted: true });
      expect(await notes(w, 'From call summary - %')).toHaveLength(0);
      expect(await factRow(w, id)).toMatchObject({ status: 'proposed', accepted: {} });
      await asUser(db, w.rep, () => db.query('select public.fn_dismiss_call_facts($1,$2)', [w.org, id]));
      const e = await failure(db, () => accept(w, w.rep, id, 'asking_price', 'x'));
      expect(e.message).toContain('NOT_ACCEPTABLE');
    });
  });

  it('claim returns the lead identifiers for redaction', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await ready(w, a);
      const c = (await claim(w)).claims[0];
      expect(c.contact_names).toEqual(expect.arrayContaining(['Sally', 'Seller', 'Sally Seller']));
      expect(c.property_address).toBe('1 Native Way');
      expect(c.property_city).toBe('Kansas City');
      // Names of the org's members, for masking spoken rep names.
      await db.query(`update auth.users set raw_user_meta_data = '{"full_name":"Rick Rep"}'::jsonb, email = 'rick.rep@example.test' where id = $1`, [w.rep]);
      await db.query('delete from public.lead_call_facts');
      const again = (await claim(w)).claims[0];
      expect(again.rep_names).toEqual(expect.arrayContaining(['Rick Rep', 'rick.rep']));
    });
  });

  it('accept refuses a field outside the allow-list, a field with no proposal, blank values and a dismissed fact', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const { id } = await done(w);
      for (const [field, value] of [['bogus', 'x'], ['timeline', 'x']]) {
        const e = await failure(db, () => accept(w, w.rep, id, field, value));
        expect(e.message).toMatch(/INVALID_INPUT|NOT_ACCEPTABLE/);
      }
      await asUser(db, w.rep, () => db.query('select public.fn_dismiss_call_facts($1,$2)', [w.org, id]));
      expect((await factRow(w, id)).status).toBe('dismissed');
      const e = await failure(db, () => accept(w, w.rep, id, 'asking_price', '$1'));
      expect(e.message).toContain('NOT_ACCEPTABLE');
      expect(await notes(w, 'From call summary - %')).toHaveLength(0);
    });
  });

  it('is isolated per org: another org cannot read, accept or dismiss, and non-members are refused', async () => {
    await withFacts(async (db) => {
      const a = await world(db, { flag: true });
      const b = await world(db, { flag: true });
      const { id } = await done(a);
      // Reads: members of org A see it, org B members do not.
      expect((await asUser(db, a.rep, () => db.query('select id from public.lead_call_facts'))).rows.map((r) => r.id)).toEqual([id]);
      expect((await asUser(db, b.rep, () => db.query('select id from public.lead_call_facts'))).rows).toEqual([]);
      // Job state is not readable by members.
      const e0 = await failure(db, () => asUser(db, a.rep, () => db.query('select claim_token from public.lead_call_facts')));
      expect((e0 as { code?: string }).code).toBe('42501');
      // Org B user naming org A is refused; naming org B finds nothing.
      const e1 = await failure(db, () => accept(a, b.rep, id, 'asking_price', '$1', a.org));
      expect((e1 as { code?: string }).code).toBe('42501');
      const e2 = await failure(db, () => accept(a, b.rep, id, 'asking_price', '$1', b.org));
      expect((e2 as { code?: string }).code).toBe('P0002');
      const e3 = await failure(db, () => asUser(db, b.rep, () => db.query('select public.fn_dismiss_call_facts($1,$2)', [b.org, id])));
      expect((e3 as { code?: string }).code).toBe('P0002');
      // No direct writes by members.
      const e4 = await failure(db, () => asUser(db, a.rep, () => db.query("update public.lead_call_facts set status='dismissed'")));
      expect((e4 as { code?: string }).code).toBe('42501');
      expect((await factRow(a, id)).status).toBe('proposed');
    });
  });

  // ---------------------------------------------------------------------------------------------
  // fn_call_known_names: one source for every known name (acceptance matrix S rows) + the drift guard.
  // ---------------------------------------------------------------------------------------------
  const known = async (w: World, activity: string) =>
    (await service(w.db, () => w.db.query('select kind, name from public.fn_call_known_names($1,$2)', [w.org, activity]))).rows as { kind: string; name: string }[];
  const names = (rows: { kind: string; name: string }[], kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.name);
  const setUser = (w: World, user: string, app: Json, meta: Json, email?: string) =>
    w.db.query(`update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || $2::jsonb, raw_user_meta_data = $3::jsonb, email = coalesce($4, email) where id = $1`,
      [user, JSON.stringify(app), JSON.stringify(meta), email ?? null]);
  const newContact = async (w: World, first: string, last: string | null, entity: string | null = null, email: string | null = null) => {
    const id = randomUUID();
    await w.db.query('insert into public.contacts (id, org_id, first_name, last_name, entity_name, email) values ($1,$2,$3,$4,$5,$6)', [id, w.org, first, last, entity, email]);
    return id;
  };

  it('matrix row 1 (S): a rep with ONLY app_metadata.display_name is returned', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await setUser(w, w.rep, { display_name: 'Rick Rep' }, {}, 'ops7@x.example');
      expect(names(await known(w, a.id), 'rep')).toEqual(expect.arrayContaining(['Rick Rep', 'ops7']));
    });
  });

  it('matrix row 2 (S): a rep with ONLY user_metadata.display_name (not full_name/name) is returned', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await setUser(w, w.rep2, {}, { display_name: 'Dana Q' });
      expect(names(await known(w, a.id), 'rep')).toContain('Dana Q');
    });
  });

  it('matrix row 3 (S): differing app and user names are BOTH returned (no coalesce), with every metadata key', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await setUser(w, w.owner, { display_name: 'Richard Roe', given_name: 'Dick' }, { name: 'Rich', full_name: 'R. Roe', first_name: 'Ricardo', last_name: 'Roe', family_name: 'Rowe', preferred_username: 'rroe' });
      expect(names(await known(w, a.id), 'rep')).toEqual(expect.arrayContaining(['Richard Roe', 'Dick', 'Rich', 'R. Roe', 'Ricardo', 'Roe', 'Rowe', 'rroe']));
    });
  });

  it('matrix row 4 (S): a rep with only an email gives its local part', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await setUser(w, w.rep, {}, {}, 'tom.baker@bmh.example');
      expect(names(await known(w, a.id), 'rep')).toContain('tom.baker');
    });
  });

  it('matrix row 5 (S): a rep known only from an identity (custom:hugo) name is returned', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await db.query(`insert into auth.identities (user_id, identity_data, provider_id, provider) values ($1, '{"name":"Hugo Lane","given_name":"Hugo"}'::jsonb, $2, 'custom:hugo')`, [w.rep, randomUUID()]);
      expect(names(await known(w, a.id), 'rep')).toEqual(expect.arrayContaining(['Hugo Lane', 'Hugo']));
    });
  });

  it('matrix row 6 (S): a suspended member and a former member who was the call operator are returned', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      const sam = randomUUID();
      await db.query('insert into auth.users(id) values ($1)', [sam]);
      await setUser(w, sam, { display_name: 'Sam Old' }, {});
      await service(db, () => db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'member','suspended')", [sam, w.org]));
      const former = randomUUID(); // no membership at all, but the call's operator
      await db.query('insert into auth.users(id) values ($1)', [former]);
      await setUser(w, former, {}, { name: 'Fran Former' });
      await db.query('update public.call_activities set operator_user_id = $2 where id = $1', [a.id, former]);
      expect(names(await known(w, a.id), 'rep')).toEqual(expect.arrayContaining(['Sam Old', 'Fran Former']));
    });
  });

  it("matrix row 7 (S): Dialpad's names for the rep (target.name) and the other party (contact.name) are returned", async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await db.query('set local session_replication_role = replica'); // the event payload is immutable outside redaction
      await db.query(`update public.dialpad_call_events set payload = payload || jsonb_build_object('target', coalesce(payload -> 'target', '{}'::jsonb) || '{"name":"Ricky R"}'::jsonb,
        'contact', coalesce(payload -> 'contact', '{}'::jsonb) || '{"name":"Sal Seller"}'::jsonb) where org_id = $1`, [w.org]);
      await db.query('set local session_replication_role = origin');
      const rows = await known(w, a.id);
      expect(names(rows, 'rep')).toContain('Ricky R');
      expect(names(rows, 'lead')).toContain('Sal Seller');
    });
  });

  it('matrix row 8 (S): a co-owner via property_contacts, the agent contact and contact emails are returned', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      const maria = await newContact(w, 'Maria', 'Gomez', null, 'maria.g@example.test');
      await db.query("insert into public.property_contacts(property_id, contact_id, org_id, source_position, source_identity) values ($1,$2,$3,1,'test')", [w.property, maria, w.org]);
      const agent = await newContact(w, 'Agent', 'Smith');
      await db.query('update public.properties set agent_contact_id = $2 where id = $1', [w.property, agent]);
      const lead = names(await known(w, a.id), 'lead');
      expect(lead).toEqual(expect.arrayContaining(['Maria Gomez', 'Maria', 'Gomez', 'maria.g', 'Agent Smith', 'Sally', 'Seller']));
    });
  });

  it('matrix row 9 (S): the dialed contact (call_activities.contact_id) differs from the homeowner and is returned', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      const heir = await newContact(w, 'Tom', 'Heir', 'Heir Holdings LLC');
      await db.query('update public.call_activities set contact_id = $2 where id = $1', [a.id, heir]);
      expect(names(await known(w, a.id), 'lead')).toEqual(expect.arrayContaining(['Tom Heir', 'Heir Holdings LLC']));
    });
  });

  it('eSign signers and lead_comps.owner_of_record for the property are returned (and only for this property)', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await db.query('set local session_replication_role = replica');
      const req = randomUUID();
      await db.query(`insert into public.esign_requests (id, org_id, property_id, template_id, send_intent_id, created_by, payload_hash, signer_snapshot) values ($1,$2,$3,$4,$5,$6,repeat('a',64),'[]'::jsonb)`,
        [req, w.org, w.property, randomUUID(), randomUUID(), w.owner]);
      await db.query(`insert into public.esign_request_signers (org_id, request_id, signer_order, role_name, signer_name, signer_email) values ($1,$2,1,'Seller','Sig Natory','sig@example.test')`, [w.org, req]);
      const other = randomUUID();
      await db.query(`insert into public.esign_requests (id, org_id, property_id, template_id, send_intent_id, created_by, payload_hash, signer_snapshot) values ($1,$2,$3,$4,$5,$6,repeat('b',64),'[]'::jsonb)`,
        [other, w.org, randomUUID(), randomUUID(), randomUUID(), w.owner]);
      await db.query(`insert into public.esign_request_signers (org_id, request_id, signer_order, role_name, signer_name, signer_email) values ($1,$2,1,'Seller','Not This Property','x@example.test')`, [w.org, other]);
      await db.query(`insert into public.lead_comps (org_id, property_id, provider, owner_of_record) values ($1,$2,'fixture','Olive Owner')`, [w.org, w.property]);
      await db.query('set local session_replication_role = origin');
      const lead = names(await known(w, a.id), 'lead');
      expect(lead).toEqual(expect.arrayContaining(['Sig Natory', 'Olive Owner']));
      expect(lead).not.toContain('Not This Property');
    });
  });

  it('is scoped to the org and call: another org\'s members and contacts are never returned', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const other = await world(db, { flag: true });
      const a = await call(w);
      await setUser(other, other.rep, { display_name: 'Outsider Person' }, {});
      expect(names(await known(w, a.id), 'rep')).not.toContain('Outsider Person');
      expect(await known(other, a.id)).toEqual([]); // wrong org for this call
      const denied = await failure(db, () => asUser(db, w.rep, () => db.query('select * from public.fn_call_known_names($1,$2)', [w.org, a.id])));
      expect((denied as { code?: string }).code).toBe('42501');
    });
  });

  it('the claim returns the single-sourced lists (contact_names = lead, rep_names = rep)', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const a = await call(w);
      await ready(w, a);
      await setUser(w, w.rep, { display_name: 'Rick Rep' }, {});
      const c = (await claim(w)).claims[0];
      expect(c.rep_names).toContain('Rick Rep');
      expect(c.contact_names).toEqual(expect.arrayContaining(['Sally']));
      expect(c.contact_names).not.toContain('Rick Rep');
    });
  });

  // Matrix row 19: a new name-bearing column fails CI until someone classifies it.
  // Every public/auth column called *name (and owner_of_record) must be tagged below. "covered" columns are
  // read by fn_call_known_names (or its JSON keys); "not_a_person" ones carry the reason they are not names
  // spoken on a lead call.
  const NAME_COLUMNS: Record<string, string> = {
    'public.contacts.first_name': 'covered_by_fn_call_known_names',
    'public.contacts.last_name': 'covered_by_fn_call_known_names',
    'public.contacts.entity_name': 'covered_by_fn_call_known_names',
    'public.esign_request_signers.signer_name': 'covered_by_fn_call_known_names',
    'public.lead_comps.owner_of_record': 'covered_by_fn_call_known_names',
    'auth.custom_oauth_providers.name': 'not_a_person (auth provider label)',
    'auth.mfa_factors.friendly_name': 'not_a_person (device label)',
    'auth.oauth_clients.client_name': 'not_a_person (app label)',
    'auth.webauthn_credentials.friendly_name': 'not_a_person (device label)',
    'public.acquisition_contract_buyer_entities.name': 'not_a_person (our own buying entity, never a call party)',
    'public.acquisition_contract_title_companies.closing_agent_name': 'not_a_person (title company setup data, never a call party)',
    'public.acquisition_contract_title_companies.name': 'not_a_person (company)',
    'public.campaign_delivery_settings.provider_campaign_name': 'not_a_person (campaign label)',
    'public.campaigns.name': 'not_a_person (campaign label)',
    'public.campaigns.provider_campaign_name': 'not_a_person (campaign label)',
    'public.counties.name': 'not_a_person (county)',
    'public.csv_import_job_provenance.list_name': 'not_a_person (list label)',
    'public.esign_request_signers.role_name': 'not_a_person (signer role)',
    'public.esign_templates.name': 'not_a_person (template title)',
    'public.fips_codes.county_name': 'not_a_person (county)',
    'public.institute_course_outcomes.learner_name': 'not_a_person (Closer Lab course learner, not a call party)',
    'public.lead_files.file_name': 'not_a_person (file name)',
    'public.lists.name': 'not_a_person (list label)',
    'public.my_leads_housekeeping_before_images.table_name': 'not_a_person (table name)',
    'public.organizations.name': 'not_a_person (our own company)',
    'public.provider_campaigns.name': 'not_a_person (campaign label)',
    'public.saved_filters.name': 'not_a_person (filter label)',
    'public.sequences.name': 'not_a_person (sequence label)',
    'public.slack_installations.team_name': 'not_a_person (Slack workspace)',
    'public.sms_templates.name': 'not_a_person (template title)',
    'public.tags.name': 'not_a_person (tag label)',
    'public.webhook_consumers.name': 'not_a_person (consumer label)',
  };
  it('matrix row 19 (S): every name-like column is classified; an unclassified one fails (drift guard)', async () => {
    await withFacts(async (db) => {
      const find = async () =>
        (await db.query(`select table_schema || '.' || table_name || '.' || column_name as c
            from information_schema.columns col
           where table_schema in ('public','auth') and (column_name ~ '(^|_)name$' or column_name = 'owner_of_record')
             and not exists (select 1 from information_schema.views v where v.table_schema = col.table_schema and v.table_name = col.table_name)
           order by 1`)).rows.map((r) => r.c as string);
      const found = await find();
      const unclassified = found.filter((c) => !(c in NAME_COLUMNS));
      expect(unclassified, `classify these in NAME_COLUMNS (covered_by_fn_call_known_names, or not_a_person with a reason), and read covered ones in fn_call_known_names`).toEqual([]);
      expect(Object.keys(NAME_COLUMNS).filter((c) => !found.includes(c)), 'stale entries').toEqual([]);
      // The guard trips: a fixture column that is not classified is reported.
      await db.query('alter table public.tags add column foo_display_name text');
      expect((await find()).filter((c) => !(c in NAME_COLUMNS))).toEqual(['public.tags.foo_display_name']);
    });
  });

  it('rollback twin drops the table and functions and leaves written notes in place', async () => {
    await withFacts(async (db) => {
      const w = await world(db, { flag: true });
      const { id } = await done(w);
      await accept(w, w.rep, id, 'asking_price', '$185,000');
      await db.query(stripTransaction('rollbacks/20261007190000_call_facts.sql'));
      expect((await db.query("select to_regclass('public.lead_call_facts') as t")).rows[0].t).toBeNull();
      expect((await db.query("select count(*)::int c from pg_proc where proname in ('fn_claim_call_facts','fn_complete_call_facts','fn_accept_call_fact','fn_dismiss_call_facts')")).rows[0].c).toBe(0);
      expect((await notes(w)).length).toBeGreaterThanOrEqual(2);
    });
  });
});
