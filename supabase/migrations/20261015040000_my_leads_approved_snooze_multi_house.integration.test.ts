import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

// 20261015040000 replaces my_leads_work_classified to carry two rules Jarrad approved word for word on 2026-10-15:
//
// Rule 1: "An offer follow-up that the rep snoozed is due at its snooze time, not its original time. Until the snooze time passes,
//          the lead stays in Waiting on them · Offer out."
// Rule 2: "A text Sandra can tie to one lead goes to that lead. A text Sandra cannot tie to one lead shows on every lead where that
//          person is the homeowner, each with a note that they own more than one house. Answering it on any of those leads counts as
//          answered on all of them."
//
// Part 1 re-runs the A1 and B1 decision-table suites, unchanged, with the migration chain extended through 20261015040000 (the same
// variant hook 20261015030000 uses), so the shipped body is what they test. Part 2 covers both rules and their boundaries.
const A1_THEN = '20261015020200_my_leads_work_facts_zip_signed_touch.sql,20261015030000_my_leads_work_classified_perf.sql,20261015040000_my_leads_approved_snooze_multi_house.sql';
const B1_THEN = '20261015030000_my_leads_work_classified_perf.sql,20261015040000_my_leads_approved_snooze_multi_house.sql';

process.env.MY_LEADS_CLASSIFIER_EXTRA_MIGRATIONS = A1_THEN;
await import('./20261015010000_my_leads_work_queue_classifier.integration.test');
process.env.MY_LEADS_CLASSIFIER_EXTRA_MIGRATIONS = B1_THEN;
await import('./20261015020200_my_leads_work_facts_zip_signed_touch.integration.test');
delete process.env.MY_LEADS_CLASSIFIER_EXTRA_MIGRATIONS;

const strip = (t: string) => t.replace(/^[\s\S]*?\bbegin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
const migration = strip(readFileSync(new URL('./20261015040000_my_leads_approved_snooze_multi_house.sql', import.meta.url), 'utf8'));
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function withDb(fn: (db: Client) => Promise<void>, sql = migration) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await db.query(sql);
    await fn(db);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

async function world(db: Client) {
  const org = randomUUID(), owner = randomUUID(), sam = randomUUID(), other = randomUUID();
  for (const id of [owner, sam, other]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1,'Approved rules')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [owner, org]);
  for (const id of [sam, other]) await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [id, org]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled,needs_sequence_owner_id) values ($1,true,$2)', [org, owner]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
  for (const id of [owner, sam, other]) {
    await db.query("select set_config('my_leads.designation_update',$1,true)", [`${owner}:${org}:${id}`]);
    await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [id, org]);
  }
  await db.query("select set_config('my_leads.designation_update','',true)");
  await db.query("select set_config('request.jwt.claim.sub','',true)");

  // Clock-independent (PR #881): every time is relative to pAt, and assignment/first call are pinned to it.
  const pAt = process.env.CLASSIFIER_TEST_ANCHOR ? new Date(process.env.CLASSIFIER_TEST_ANCHOR) : new Date();
  const at = (ms: number) => new Date(pAt.getTime() + ms).toISOString();
  const raw = async (sql: string, params: unknown[]) => {
    await db.query("set local session_replication_role='replica'");
    try { await db.query(sql, params); } catch (error) { await db.query('rollback'); throw error; }
    await db.query("set local session_replication_role='origin'");
  };
  let phoneSeq = 0;
  const contact = async () => {
    const id = randomUUID();
    phoneSeq += 1;
    await db.query("insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values ($1,$2,'Rule','Lead',$3,'mobile')",
      [id, org, `+181677${String(phoneSeq).padStart(5, '0')}`]);
    return id;
  };
  const attempt = (property: string, when: string, outcome = 'no_answer', actor: string = sam) => raw(
    "insert into public.acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,occurred_at,recorded_at,idempotency_key,outcome) values ($1,$2,$3,'outreach','manual',$4,$4,$5,$6)",
    [org, property, actor, when, randomUUID(), outcome]);
  const lead = async (o: { homeowner?: string; assignee?: string; stage?: string } = {}) => {
    const id = randomUUID();
    const assignee = o.assignee ?? sam;
    const homeowner = o.homeowner ?? await contact();
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id,homeowner_contact_id) values ($1,$2,$3,'MO','new_lead',$4,$5)",
      [id, org, `${id.slice(0, 8)} Main`, assignee, homeowner]);
    await raw('update public.acquisition_assignment_episodes set assigned_at=$2, first_call_started_at=$3, first_call_actor_user_id=$4 where property_id=$1 and ended_at is null',
      [id, at(-31 * DAY), at(-30 * DAY), assignee]);
    if (o.stage) await raw(
      `insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at) values ($1,$2,$3,$4)
       on conflict (property_id,org_id) do update set stage=excluded.stage, stage_entered_at=excluded.stage_entered_at`, [id, org, o.stage, at(-HOUR)]);
    await attempt(id, at(-30 * DAY), 'no_answer', assignee);
    return { id, homeowner };
  };
  const text = async (property: string | null, homeowner: string, direction: 'inbound' | 'outbound', when: string, meta: Json = {}) => {
    const id = randomUUID();
    await raw(`insert into public.messages(id,org_id,channel,direction,body,status,property_id,contact_id,created_at,metadata)
               values ($1,$2,'sms',$3,'hi',$4,$5,$6,$7,$8)`,
      [id, org, direction, direction === 'inbound' ? 'received' : 'sent', property, homeowner, when, JSON.stringify(meta)]);
    return id;
  };
  const event = (property: string, type: string, when: string) => raw(
    "insert into public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,created_at) values ($1,$2,'user',$3,$4,'{}',$5)",
    [org, property, sam, type, when]);
  const enroll = async (property: string, when: string) => {
    const seq = randomUUID();
    await raw('insert into public.sequences(id,org_id,name) values ($1,$2,$3)', [seq, org, `Check-in ${seq}`]);
    await raw("insert into public.sequence_steps(id,sequence_id,step_index,action_type,template_body) values ($1,$2,0,'send_sms','hello')", [randomUUID(), seq]);
    await raw(`insert into public.sequence_enrollments(id,org_id,sequence_id,property_id,status,current_step_index,next_run_at,updated_at,enrolled_by_user_id,enrolled_at)
               values ($1,$2,$3,$4,'completed',0,null,$5,$6,$5)`, [randomUUID(), org, seq, property, when, sam]);
  };
  const chainOffer = async (property: string, due: string, snoozedUntil: string | null) => {
    const chain = randomUUID();
    await raw(
      'insert into public.tasks(org_id,type,status,title,due_at,end_at,assignee_id,created_by,calendar_chain_id,related_property_id,snoozed_until) values ($1,\'appointment\',$2,\'Offer follow-up\',$3,$4,$5,$5,$6,$7,$8)',
      [org, snoozedUntil ? 'snoozed' : 'open', due, new Date(new Date(due).getTime() + 15 * MIN).toISOString(), sam, chain, property, snoozedUntil]);
    await raw(
      `insert into public.acquisition_offers(org_id,property_id,actor_user_id,amount_cents,sent_via,sent_at,follow_up_at,outcome,idempotency_key,follow_up_calendar_chain_id)
       values ($1,$2,$3,150000,'verbal',$4,$5,'pending',$6,$7)`, [org, property, sam, at(-3 * DAY), due, randomUUID(), chain]);
  };
  const classified = async (when: Date = pAt, member = sam): Promise<Record<string, Json>> => {
    const r = (await db.query('select * from public.my_leads_work_classified($1,$2,$3)', [org, member, when.toISOString()])).rows;
    return Object.fromEntries(r.map((x) => [x.property_id, x]));
  };
  // A rep text whose only proof of acceptance is its ledger receipt(s): message status pending, no sent_at.
  const ledgered = async (property: string, homeowner: string, when: string, receipts: Array<[string, string]>) => {
    const id = randomUUID();
    await raw(`insert into public.messages(id,org_id,channel,direction,body,status,property_id,contact_id,created_at,metadata)
               values ($1,$2,'sms','outbound','hi','pending',$3,$4,$5,'{}')`, [id, org, property, homeowner, when]);
    for (const [state, updated] of receipts) await raw(
      `insert into public.rep_sms_delivery_ledger(id,org_id,actor_user_id,submission_key,property_id,contact_id,sender_assignment_id,provider,provider_account_id,provider_sender_id,from_number,to_number,body,state,claim_token,message_id,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,'sendillo','acct','sender','+18165550100','+18165550101','hi',$8,$9,$10,$11,$11)`,
      [randomUUID(), org, sam, randomUUID(), property, homeowner, randomUUID(), state, randomUUID(), id, updated]);
    return id;
  };
  return { org, sam, other, pAt, at, raw, contact, lead, text, attempt, event, enroll, chainOffer, ledgered, classified };
}

const cell = (r: Json) => `${r.place}/${r.reason}/${r.row_no}`;

describe('Rule 1: a snoozed offer follow-up is due at its snooze time', () => {
  it('Waiting · Offer out until the snooze time, Needs attention · Offer from it, no early window; unsnoozed keeps the window', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const snoozed = await w.lead({ stage: 'offer_sent' }); await w.chainOffer(snoozed.id, w.at(-HOUR), w.at(DAY));
      const passed = await w.lead({ stage: 'offer_sent' }); await w.chainOffer(passed.id, w.at(-2 * DAY), w.at(-HOUR));
      const plain = await w.lead({ stage: 'offer_sent' }); await w.chainOffer(plain.id, w.at(-HOUR), null);
      const r = await w.classified();
      expect(cell(r[snoozed.id])).toBe('their_move/offer_out/12');
      expect(new Date(r[snoozed.id].facts.headline.at).getTime()).toBe(new Date(w.at(DAY)).getTime());
      expect(cell(r[passed.id])).toBe('your_move/offer/8');
      expect(cell(r[plain.id])).toBe('your_move/offer/8');
      // Ruling (Jarrad, 2026-10-15): no 15-minute early window for a snoozed chain task; next_change_at is the snooze time itself
      const end = new Date(w.at(DAY));
      expect(new Date(r[snoozed.id].next_change_at).getTime()).toBe(end.getTime());
      expect(cell((await w.classified(new Date(end.getTime() - 10 * MIN)))[snoozed.id])).toBe('their_move/offer_out/12');
      expect(cell((await w.classified(new Date(end.getTime() - 1)))[snoozed.id])).toBe('their_move/offer_out/12');
      expect(cell((await w.classified(end))[snoozed.id])).toBe('your_move/offer/8');
      expect(cell((await w.classified(new Date(end.getTime() + 1)))[snoozed.id])).toBe('your_move/offer/8');
      // an unsnoozed chain follow-up still shows 15 minutes early
      const early = await w.lead({ stage: 'offer_sent' }); await w.chainOffer(early.id, w.at(15 * MIN), null);
      const r2 = await w.classified();
      expect(cell(r2[early.id])).toBe('your_move/offer/8');
      expect(cell((await w.classified(new Date(w.pAt.getTime() - 1)))[early.id])).toBe('their_move/offer_out/12');
    });
  });
});

describe('Rule 1: the snooze time wins whether it is earlier than, equal to or later than the original due time', () => {
  for (const [name, dueFromEnd] of [['earlier than due', 2 * DAY], ['equal to due', 0], ['later than due', -2 * DAY]] as const) {
    it(`snoozed ${name}: Waiting until the snooze time, Needs attention from it, next_change_at = snooze time`, async () => {
      await withDb(async (db) => {
        const w = await world(db);
        const end = new Date(w.pAt.getTime() + DAY);
        const l = await w.lead({ stage: 'offer_sent' }); await w.chainOffer(l.id, new Date(end.getTime() + dueFromEnd).toISOString(), end.toISOString());
        const r = await w.classified();
        expect(cell(r[l.id])).toBe('their_move/offer_out/12');
        expect(new Date(r[l.id].next_change_at).getTime()).toBe(end.getTime());
        expect(cell((await w.classified(new Date(end.getTime() - 1)))[l.id])).toBe('their_move/offer_out/12');
        expect(cell((await w.classified(end))[l.id])).toBe('your_move/offer/8');
        expect(cell((await w.classified(new Date(end.getTime() + 1)))[l.id])).toBe('your_move/offer/8');
      });
    });
  }
});

describe('Rule 2: a text Sandra cannot tie to one lead', () => {
  it('a text tied to one lead stays on that lead; a contact-only text of a one-house homeowner is a New reply with count 1', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const h = await w.contact();
      const a = await w.lead({ homeowner: h }), b = await w.lead({ homeowner: h });
      await w.text(a.id, h, 'inbound', w.at(-3 * HOUR));
      const single = await w.lead();
      await w.text(null, single.homeowner, 'inbound', w.at(-3 * HOUR));
      const r = await w.classified();
      expect(cell(r[a.id])).toBe('your_move/new_reply/5');
      expect(cell(r[b.id])).toBe('your_move/nothing_planned/15');
      expect(r[a.id].facts).not.toHaveProperty('homeownerPropertyCount');
      expect(r[b.id].facts).not.toHaveProperty('homeownerPropertyCount');
      expect(cell(r[single.id])).toBe('your_move/new_reply/5');
      expect(r[single.id].facts.homeownerPropertyCount).toBe(1);
    });
  });

  it('shows on every lead of that homeowner, each carrying the house count (deleted properties excluded, other reps included)', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const h = await w.contact();
      const a = await w.lead({ homeowner: h }), b = await w.lead({ homeowner: h });
      const c = await w.lead({ homeowner: h, assignee: w.other });
      const gone = await w.lead({ homeowner: h });
      await w.raw('update public.properties set deleted_at=$2 where id=$1', [gone.id, w.at(-DAY)]);
      await w.text(null, h, 'inbound', w.at(-3 * HOUR));
      const r = await w.classified();
      for (const id of [a.id, b.id]) {
        expect(cell(r[id])).toBe('your_move/new_reply/5');
        expect(r[id].facts.homeownerPropertyCount).toBe(3);
        expect(r[id].labels).toContain('check_texts');
      }
      expect(cell((await w.classified(w.pAt, w.other))[c.id])).toBe('your_move/new_reply/5');
    });
  });

  const answers: Array<[string, (w: Awaited<ReturnType<typeof world>>, on: { id: string; homeowner: string }, inbound: string, t: string) => Promise<unknown>]> = [
    ['a reply stamped to that text', (w, on, inbound, t) => w.text(on.id, on.homeowner, 'outbound', t, { inbound_message_id: inbound })],
    ['an unstamped human text', (w, on, _i, t) => w.text(on.id, on.homeowner, 'outbound', t)],
    ['a reached call', (w, on, _i, t) => w.attempt(on.id, t, 'reached')],
    ['a voicemail', (w, on, _i, t) => w.attempt(on.id, t, 'voicemail')],
    ['a handling event', (w, on, _i, t) => w.event(on.id, 'dispo_set', t)],
    ['a rep-started drip', (w, on, _i, t) => w.enroll(on.id, t)],
  ];
  for (const [what, answer] of answers) {
    it(`answered on one lead by ${what} counts as answered on all, including another rep's lead; a newer text reopens all`, async () => {
      await withDb(async (db) => {
        const w = await world(db);
        const h = await w.contact();
        const a = await w.lead({ homeowner: h }), b = await w.lead({ homeowner: h }), c = await w.lead({ homeowner: h, assignee: w.other });
        const inbound = await w.text(null, h, 'inbound', w.at(-3 * HOUR));
        await answer(w, b, inbound, w.at(-HOUR));
        const r = await w.classified();
        for (const id of [a.id, b.id]) {
          expect(r[id].row_no).not.toBe('5');
          expect(r[id].facts.latestInbound.handled).toBe(true);
          expect(r[id].facts.homeownerPropertyCount).toBe(3);
        }
        expect((await w.classified(w.pAt, w.other))[c.id].row_no).not.toBe('5');
        await w.text(null, h, 'inbound', w.at(-30 * MIN));
        const r2 = await w.classified();
        for (const id of [a.id, b.id]) expect(cell(r2[id])).toBe('your_move/new_reply/5');
        expect(cell((await w.classified(w.pAt, w.other))[c.id])).toBe('your_move/new_reply/5');
      });
    });
  }

  it('boundaries: an answer before the text, a stamp to an older text, an unresolved stamp and a no-answer call do not answer it', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const h = await w.contact();
      const a = await w.lead({ homeowner: h }), b = await w.lead({ homeowner: h });
      const older = await w.text(null, h, 'inbound', w.at(-5 * HOUR));
      await w.text(b.id, h, 'outbound', w.at(-4 * HOUR));
      await w.text(null, h, 'inbound', w.at(-3 * HOUR));
      await w.text(b.id, h, 'outbound', w.at(-2 * HOUR), { inbound_message_id: older });
      await w.text(b.id, h, 'outbound', w.at(-90 * MIN), { inbound_stamp_unresolved: 'true' });
      await w.attempt(b.id, w.at(-HOUR), 'no_answer');
      const r = await w.classified();
      for (const id of [a.id, b.id]) expect(cell(r[id])).toBe('your_move/new_reply/5');
    });
  });

  it('a different homeowner answering does not count', async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const h = await w.contact();
      const a = await w.lead({ homeowner: h }), b = await w.lead({ homeowner: h });
      const stranger = await w.lead();
      await w.text(null, h, 'inbound', w.at(-3 * HOUR));
      await w.text(stranger.id, stranger.homeowner, 'outbound', w.at(-HOUR));
      await w.attempt(stranger.id, w.at(-HOUR), 'reached');
      const r = await w.classified();
      for (const id of [a.id, b.id]) expect(cell(r[id])).toBe('your_move/new_reply/5');
    });
  });

  // A sibling's answer whose only proof of acceptance is its ledger receipt (the latest receipt per message wins).
  const receiptCases: Array<[string, Array<[number, string]>, boolean]> = [
    ['accepted', [[0, 'accepted']], true],
    ['delivered', [[0, 'delivered']], true],
    ['delivery_failed (accepted, then failed)', [[0, 'delivery_failed']], true],
    ['reserved', [[0, 'reserved']], false],
    ['sending', [[0, 'sending']], false],
    ['failed_not_dispatched', [[0, 'failed_not_dispatched']], false],
    ['blocked', [[0, 'blocked']], false],
    ['unknown', [[0, 'unknown']], false],
    ['older accepted, newer failed_not_dispatched (latest wins)', [[0, 'accepted'], [MIN, 'failed_not_dispatched']], false],
    ['older failed_not_dispatched, newer delivered (latest wins)', [[0, 'failed_not_dispatched'], [MIN, 'delivered']], true],
  ];
  for (const [what, receipts, answers] of receiptCases) {
    it(`a sibling text backed only by a ${what} ledger receipt ${answers ? 'answers' : 'does not answer'} it on every lead`, async () => {
      await withDb(async (db) => {
        const w = await world(db);
        const h = await w.contact();
        const a = await w.lead({ homeowner: h }), b = await w.lead({ homeowner: h });
        await w.text(null, h, 'inbound', w.at(-3 * HOUR));
        const sent = w.pAt.getTime() - HOUR;
        await w.ledgered(b.id, h, new Date(sent).toISOString(), receipts.map(([d, st]) => [st, new Date(sent + d).toISOString()]));
        const r = await w.classified();
        expect(r[a.id].facts.latestInbound.handled).toBe(answers);
        expect(r[b.id].facts.latestInbound.handled).toBe(answers);
      });
    });
  }

  it('mutation: with the cross-lead receipt read emptied, a ledger-only sibling answer no longer answers the owner lead', async () => {
    const needle = 'where l.org_id = p_org and l.message_id in (select id from cm)';
    expect(migration.split(needle).length).toBe(2);
    await withDb(async (db) => {
      const w = await world(db);
      const h = await w.contact();
      const a = await w.lead({ homeowner: h }), b = await w.lead({ homeowner: h });
      await w.text(null, h, 'inbound', w.at(-3 * HOUR));
      await w.ledgered(b.id, h, w.at(-HOUR), [['accepted', w.at(-HOUR)]]);
      const r = await w.classified();
      expect(r[a.id].facts.latestInbound.handled).toBe(false);
      expect(r[a.id].row_no).toBe('5');
    }, migration.replace(needle, 'where false and l.org_id = p_org and l.message_id in (select id from cm)'));
  });
});

export {};
