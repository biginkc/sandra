import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

const strip = (file: string) => {
  const sql = readFileSync(new URL(file, import.meta.url), 'utf8');
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error(`${file}: transaction wrapper changed`);
  return sql.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
};
const chain = [
  './20261005100000_my_leads_housekeeping_tools.sql',
  './20261005100100_my_leads_housekeeping_reassign.sql',
  './20261005110000_acquisition_attempt_outcome_voicemail_not_logged.sql',
  './20261005120000_next_step_schema.sql',
  './20261005120500_fn_create_next_step.sql',
  './20261005121000_next_step_read_model.sql',
  './20261005121200_next_step_mode_aware_lifecycle.sql',
  './20261005121500_next_step_relabel_functions.sql',
  './20261005130000_offer_follow_up_chain.sql',
].map(strip);
const migration = strip('./20261005150000_my_leads_call_next.sql');
const rollback = strip('../rollbacks/20261005150000_my_leads_call_next.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Role = 'authenticated' | 'anon' | 'service_role';

async function withDb(fn: (db: Client) => Promise<void>) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    for (const file of [...chain, migration]) await db.query(file);
    await fn(db);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

async function world(db: Client) {
  const org = randomUUID(), jarrad = randomUUID(), sam = randomUUID(), other = randomUUID();
  for (const id of [jarrad, sam, other]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1,'Call next')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [jarrad, org]);
  for (const id of [sam, other]) await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [id, org]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled,needs_sequence_owner_id) values ($1,true,$2)', [org, jarrad]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [jarrad]);
  for (const id of [jarrad, sam, other]) {
    await db.query("select set_config('my_leads.designation_update',$1,true)", [`${jarrad}:${org}:${id}`]);
    await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [id, org]);
  }
  await db.query("select set_config('my_leads.designation_update','',true)");
  await db.query("select set_config('request.jwt.claim.sub','',true)");

  const pAt = new Date();
  const at = (ms: number) => new Date(pAt.getTime() + ms).toISOString();
  let phoneSeq = 0;
  const lead = async (key: string, o: { assignee?: string; phone?: boolean; stage?: string; motivation?: string; dnc?: boolean } = {}) => {
    const id = randomUUID();
    const assignee = o.assignee ?? sam;
    let contact: string | null = null;
    if (o.phone !== false || o.dnc) {
      contact = randomUUID();
      phoneSeq += 1;
      await db.query('insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values ($1,$2,$3,$4,$5,$6)', [contact, org, key, 'Lead', o.phone === false ? null : `+181655${String(phoneSeq).padStart(5, '0')}`, o.phone === false ? null : 'mobile']);
    }
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id,homeowner_contact_id,motivation_level) values ($1,$2,$3,'MO','new_lead',$4,$5,$6)",
      [id, org, `${key} Main`, assignee, contact, o.motivation ?? null]);
    if (o.dnc && contact) {
      await db.query("set local session_replication_role='replica'");
      await db.query('update public.contacts set do_not_contact=true where id=$1', [contact]);
      await db.query("set local session_replication_role='origin'");
    }
    if (o.stage) await setStage(id, o.stage);
    return id;
  };
  const setStage = async (property: string, stage: string, enteredAt = at(-HOUR)) => {
    await db.query(
      `insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at) values ($1,$2,$3,$4)
       on conflict (property_id,org_id) do update set stage=excluded.stage, stage_entered_at=excluded.stage_entered_at`, [property, org, stage, enteredAt]);
  };
  const raw = async (sql: string, params: unknown[]) => {
    await db.query("set local session_replication_role='replica'");
    try { await db.query(sql, params); } catch (error) { await db.query('rollback'); throw error; }
    await db.query("set local session_replication_role='origin'");
  };
  const attempt = (property: string, when: string) => raw(
    "insert into public.acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,occurred_at,idempotency_key,outcome) values ($1,$2,$3,'outreach','manual',$4,$5,'no_answer')",
    [org, property, sam, when, randomUUID()]);
  const text = async (property: string, direction: 'inbound' | 'outbound', when: string, o: { status?: string; contactOnly?: boolean } = {}) => {
    const contact = (await db.query('select homeowner_contact_id as c from public.properties where id=$1', [property])).rows[0].c;
    await raw("insert into public.messages(org_id,channel,direction,body,status,property_id,contact_id,created_at) values ($1,'sms',$2,'hi',$3,$4,$5,$6)",
      [org, direction, o.status ?? (direction === 'inbound' ? 'received' : 'sent'), o.contactOnly ? null : property, contact, when]);
  };
  const note = (property: string, when: string) => raw('insert into public.lead_notes(org_id,property_id,author_user_id,body,created_at) values ($1,$2,$3,$4,$5)', [org, property, sam, 'note', when]);
  const call = async (property: string, direction: 'inbound' | 'outbound', started: string, o: { ended?: boolean; talk?: number } = {}) => {
    const contact = (await db.query('select homeowner_contact_id as c from public.properties where id=$1', [property])).rows[0].c;
    await raw('insert into public.call_activities(org_id,property_id,contact_id,jitter_attempt_id,jitter_session_id,direction,started_at,ended_at,talk_duration_seconds) values ($1,$2,$3,$4,$4,$5,$6,$7,$8)',
      [org, property, contact, randomUUID(), direction, started, o.ended === false ? null : started, o.talk ?? 0]);
  };
  const appt = async (property: string, due: string, o: { type?: string; status?: string; chain?: string } = {}) => {
    const type = o.type ?? 'appointment';
    const status = o.status ?? 'open';
    const chainId = type === 'appointment' ? (o.chain ?? randomUUID()) : null;
    const end = type === 'appointment' ? new Date(new Date(due).getTime() + 15 * MIN).toISOString() : null;
    const snoozed = status === 'snoozed' ? new Date(new Date(due).getTime() + 5 * DAY).toISOString() : null;
    const outcome = type === 'appointment' && (status === 'completed' || status === 'cancelled') ? (status === 'completed' ? 'held' : 'cancelled') : null;
    await raw(
      'insert into public.tasks(org_id,type,status,title,due_at,end_at,assignee_id,created_by,calendar_chain_id,related_property_id,snoozed_until,outcome) values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11)',
      [org, type, status, `${type} task`, due, end, sam, chainId, property, snoozed, outcome]);
    return chainId;
  };
  const offer = async (property: string, o: { sentAt?: string; followUpAt: string; chain?: string | null }) => {
    await raw(
      `insert into public.acquisition_offers(org_id,property_id,actor_user_id,amount_cents,sent_via,sent_at,follow_up_at,outcome,idempotency_key,follow_up_calendar_chain_id)
       values ($1,$2,$3,150000,'verbal',$4,$5,'pending',$6,$7)`,
      [org, property, sam, o.sentAt ?? at(-3 * DAY), o.followUpAt, randomUUID(), o.chain ?? null]);
  };
  const drip = async (property: string, status = 'active') => {
    const seq = randomUUID();
    await raw("insert into public.sequences(id,org_id,name) values ($1,$2,$3)", [seq, org, `drip ${seq}`]);
    await raw('insert into public.sequence_enrollments(org_id,sequence_id,property_id,status) values ($1,$2,$3,$4)', [org, seq, property, status]);
  };
  const setAssigned = (property: string, when: string) => raw('update public.acquisition_assignment_episodes set assigned_at=$2 where property_id=$1 and ended_at is null', [property, when]);

  const rowsAt = async (when: Date = pAt, member = sam): Promise<Record<string, Json>> => {
    const r = (await db.query('select * from public.my_leads_call_next_rows($1,$2,$3)', [org, member, when.toISOString()])).rows;
    return Object.fromEntries(r.map((x) => [x.property_id, x]));
  };
  const rows = (member = sam) => rowsAt(pAt, member);
  const order = (m: Record<string, Json>) => Object.values(m)
    .filter((r) => !r.excluded_reason && !r.hidden)
    .sort((a, b) => a.tier - b.tier || a.sort_key - b.sort_key || +new Date(a.assignment_sort) - +new Date(b.assignment_sort) || (a.property_id < b.property_id ? -1 : 1))
    .map((r) => r.property_id as string);
  const as = async <T,>(role: Role, sub: string | null, run: () => Promise<T>) => {
    await db.query(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sub ?? '']);
    try { return await run(); } finally { await db.query('reset role').catch(() => {}); }
  };
  const expectError = async (run: () => Promise<unknown>, pattern: RegExp) => {
    await db.query('savepoint s');
    let failure: unknown = null;
    try { await run(); } catch (error) { failure = error; }
    await db.query('rollback to savepoint s');
    await db.query('reset role');
    expect(String((failure as Error)?.message)).toMatch(pattern);
  };
  const strip10 = (sub: string, member = sam, limit?: number) => as('authenticated', sub, async () =>
    (await db.query('select public.fn_get_my_leads_call_next($1,$2,$3) as r', [org, member, limit ?? 10])).rows[0].r as Json);
  const setOverride = (sub: string, member: string, property: string, action: string) => as('authenticated', sub, async () =>
    (await db.query('select public.fn_set_my_leads_strip_override($1,$2,$3,$4) as r', [org, member, property, action])).rows[0].r as Json);
  return { org, jarrad, sam, other, pAt, at, lead, setStage, attempt, text, note, call, appt, offer, drip, setAssigned, rows, rowsAt, order, as, expectError, strip10, setOverride, raw };
}

it('puts one lead in every tier with the right reason and reason time', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const pinned = await w.lead('pinned');
    await w.raw('insert into public.my_leads_strip_overrides(org_id,member_id,property_id,pinned_at,pinned_until) values ($1,$2,$3,$4,$5)', [w.org, w.sam, pinned, w.at(-2 * HOUR), w.at(5 * HOUR)]);
    const due = await w.lead('due');
    await w.appt(due, w.at(10 * MIN));
    const overdue = await w.lead('overdue');
    await w.appt(overdue, w.at(-2 * DAY));
    const later = await w.lead('later');   // due in 20 minutes is not tier 1
    await w.appt(later, w.at(20 * MIN));
    const inText = await w.lead('inText');
    await w.text(inText, 'inbound', w.at(-3 * HOUR));
    const inCall = await w.lead('inCall');
    await w.call(inCall, 'inbound', w.at(-1 * HOUR));
    const needs = await w.lead('needs', { stage: 'needs_offer' });
    const offerChain = await w.lead('offerChain', { stage: 'offer_sent' });
    const chainId = await w.appt(offerChain, w.at(-3 * HOUR));
    await w.offer(offerChain, { followUpAt: w.at(-3 * HOUR), chain: chainId });
    const offerLegacy = await w.lead('offerLegacy', { stage: 'offer_sent' });
    await w.offer(offerLegacy, { followUpAt: w.at(-1 * DAY) });
    const offerFuture = await w.lead('offerFuture', { stage: 'offer_sent' });
    await w.offer(offerFuture, { followUpAt: w.at(2 * DAY) });
    const hot = await w.lead('hot', { motivation: 'hot' });
    await w.attempt(hot, w.at(-5 * DAY));
    const warm = await w.lead('warm', { motivation: 'warm' });
    await w.note(warm, w.at(-4 * DAY));
    const warmFresh = await w.lead('warmFresh', { motivation: 'warm' });
    await w.attempt(warmFresh, w.at(-1 * DAY));
    const plain = await w.lead('plain');
    await w.attempt(plain, w.at(-12 * DAY));

    const r = await w.rows();
    const at = (id: string) => (r[id].reason_at ? new Date(r[id].reason_at).toISOString() : null);
    expect(r[pinned]).toMatchObject({ tier: 0, reason: 'pinned_call_today', pinned: true });
    expect(at(pinned)).toBe(w.at(-2 * HOUR));
    expect(r[due]).toMatchObject({ tier: 1, reason: 'appointment_due' });
    expect(at(due)).toBe(w.at(10 * MIN));
    expect(r[overdue]).toMatchObject({ tier: 1, reason: 'appointment_overdue' });
    expect(r[later]).toMatchObject({ tier: 5, reason: 'longest_since_touch' });
    expect(r[inText]).toMatchObject({ tier: 2, reason: 'inbound_text' });
    expect(at(inText)).toBe(w.at(-3 * HOUR));
    expect(r[inCall]).toMatchObject({ tier: 2, reason: 'inbound_call' });
    expect(r[needs]).toMatchObject({ tier: 3, reason: 'needs_offer' });
    // An offer follow-up appointment is tier 3, not tier 1.
    expect(r[offerChain]).toMatchObject({ tier: 3, reason: 'offer_follow_up_overdue' });
    expect(at(offerChain)).toBe(w.at(-3 * HOUR));
    // No chain yet: falls back to acquisition_offers.follow_up_at.
    expect(r[offerLegacy]).toMatchObject({ tier: 3, reason: 'offer_follow_up_overdue' });
    expect(at(offerLegacy)).toBe(w.at(-1 * DAY));
    expect(r[offerFuture].tier).toBe(5);
    expect(r[hot]).toMatchObject({ tier: 4, reason: 'hot_going_cold' });
    expect(r[warm]).toMatchObject({ tier: 4, reason: 'warm_going_cold' });
    expect(r[warmFresh].tier).toBe(5);
    expect(r[plain]).toMatchObject({ tier: 5, reason: 'longest_since_touch' });
    expect(new Date(r[plain].last_touch_at).toISOString()).toBe(w.at(-12 * DAY));
  });
});

it('orders inside tiers, breaks ties by assignment age then id, and never-touched sorts first in tier 5', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const a1 = await w.lead('a1'); await w.appt(a1, w.at(-1 * HOUR));
    const a2 = await w.lead('a2'); await w.appt(a2, w.at(-3 * HOUR));
    const a3 = await w.lead('a3'); await w.appt(a3, w.at(5 * MIN));
    const t1 = await w.lead('t1'); await w.text(t1, 'inbound', w.at(-5 * HOUR));
    const t2 = await w.lead('t2'); await w.text(t2, 'inbound', w.at(-1 * HOUR));
    const f1 = await w.lead('f1'); await w.attempt(f1, w.at(-2 * DAY));
    const f2 = await w.lead('f2'); await w.attempt(f2, w.at(-9 * DAY));
    const never = await w.lead('never');
    expect(w.order(await w.rows())).toEqual([a2, a1, a3, t2, t1, never, f2, f1]);

    // Equal sort keys: older assignment first, then property id.
    const x = await w.lead('x'); const y = await w.lead('y'); const z = await w.lead('z');
    await w.attempt(x, w.at(-30 * DAY)); await w.attempt(y, w.at(-30 * DAY)); await w.attempt(z, w.at(-30 * DAY));
    await w.setAssigned(y, w.at(-40 * DAY)); await w.setAssigned(x, w.at(-20 * DAY)); await w.setAssigned(z, w.at(-20 * DAY));
    const ids = w.order(await w.rows()).filter((id) => [x, y, z].includes(id));
    const [first, ...rest] = ids;
    expect(first).toBe(y);
    expect(rest).toEqual([x, z].sort());
  });
});

it('inbound is dropped by a later outbound text, note, call or attempt, but an inbound after the touch stays', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const afterText = await w.lead('afterText'); await w.text(afterText, 'inbound', w.at(-5 * HOUR)); await w.text(afterText, 'outbound', w.at(-4 * HOUR));
    const afterNote = await w.lead('afterNote'); await w.text(afterNote, 'inbound', w.at(-5 * HOUR)); await w.note(afterNote, w.at(-4 * HOUR));
    const afterCall = await w.lead('afterCall'); await w.text(afterCall, 'inbound', w.at(-5 * HOUR)); await w.call(afterCall, 'outbound', w.at(-4 * HOUR));
    const afterAttempt = await w.lead('afterAttempt'); await w.text(afterAttempt, 'inbound', w.at(-5 * HOUR)); await w.attempt(afterAttempt, w.at(-4 * HOUR));
    const replied = await w.lead('replied'); await w.text(replied, 'outbound', w.at(-5 * HOUR)); await w.text(replied, 'inbound', w.at(-4 * HOUR));
    const failedOut = await w.lead('failedOut'); await w.text(failedOut, 'inbound', w.at(-5 * HOUR)); await w.text(failedOut, 'outbound', w.at(-4 * HOUR), { status: 'failed' });
    const contactOnly = await w.lead('contactOnly'); await w.text(contactOnly, 'inbound', w.at(-2 * HOUR), { contactOnly: true });
    const answeredCall = await w.lead('answeredCall'); await w.call(answeredCall, 'inbound', w.at(-2 * HOUR), { talk: 120 });
    const ringing = await w.lead('ringing'); await w.call(ringing, 'inbound', w.at(-2 * HOUR), { ended: false });
    const r = await w.rows();
    for (const id of [afterText, afterNote, afterCall, afterAttempt]) expect(r[id].tier, id).toBe(5);
    expect(r[replied].tier).toBe(2);
    expect(r[failedOut].tier).toBe(2);   // a failed outbound text is not a touch
    expect(r[contactOnly]).toMatchObject({ tier: 2, reason: 'inbound_text' });
    expect(r[answeredCall].tier).toBe(5);
    expect(r[ringing].tier).toBe(5);
    expect(new Date(r[afterText].last_touch_at).toISOString()).toBe(w.at(-4 * HOUR));
  });
});

it('ignores snoozed tasks, counts a legacy callback, and ignores closed or other-lead appointments', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const snoozed = await w.lead('snoozed'); await w.appt(snoozed, w.at(-1 * HOUR), { status: 'snoozed', type: 'callback' });
    const callback = await w.lead('callback'); await w.appt(callback, w.at(-1 * HOUR), { type: 'callback' });
    const followUp = await w.lead('followUp'); await w.appt(followUp, w.at(2 * MIN), { type: 'follow_up' });
    const done = await w.lead('done'); await w.appt(done, w.at(-1 * HOUR), { status: 'completed' });
    const inPerson = await w.lead('inPerson'); await w.appt(inPerson, w.at(-1 * HOUR));
    await w.raw("update public.tasks set mode='in_person', location='123 Elm' where related_property_id=$1", [inPerson]);
    const r = await w.rows();
    expect(r[snoozed].tier).toBe(5);
    expect(r[callback]).toMatchObject({ tier: 1, reason: 'appointment_overdue' });
    expect(r[followUp]).toMatchObject({ tier: 1, reason: 'appointment_due' });
    expect(r[done].tier).toBe(5);
    expect(r[inPerson].tier).toBe(1);
  });
});

it('excludes phone-less and DNC-contact leads (flagged), and leaves drip-active leads out entirely', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const noPhone = await w.lead('noPhone', { phone: false });
    const noContact = await w.lead('noContact', { phone: false });
    const dnc = await w.lead('dnc', { dnc: true });
    const ok = await w.lead('ok');
    const dripActive = await w.lead('dripActive'); await w.drip(dripActive);
    const dripPaused = await w.lead('dripPaused'); await w.drip(dripPaused, 'paused'); await w.text(dripPaused, 'inbound', w.at(-1 * HOUR));
    const r = await w.rows();
    expect(r[noPhone].excluded_reason).toBe('no_phone');
    expect(r[noContact].excluded_reason).toBe('no_phone');
    expect(r[dnc].excluded_reason).toBe('contact_dnc');
    expect(r[ok].excluded_reason).toBeNull();
    expect(r[dripActive]).toBeUndefined();
    expect(r[dripPaused]).toMatchObject({ tier: 2, excluded_reason: null });
    const snap = await w.strip10(w.sam);
    expect(snap.excluded.map((e: Json) => e.reason).sort()).toEqual(['contact_dnc', 'no_phone', 'no_phone']);
    expect(snap.excluded.find((e: Json) => e.propertyId === dnc).address).toBe('dnc Main');
    expect(snap.rows.map((x: Json) => x.propertyId)).not.toContain(noPhone);
    // A pin never rescues an excluded lead.
    await w.raw('insert into public.my_leads_strip_overrides(org_id,member_id,property_id,pinned_at,pinned_until) values ($1,$2,$3,$4,$5)', [w.org, w.sam, dnc, w.at(-HOUR), w.at(HOUR)]);
    expect((await w.strip10(w.sam)).rows.map((x: Json) => x.propertyId)).not.toContain(dnc);
  });
});

it('pins stay until a call or Chicago midnight; a text or note does not unpin; hides expire at midnight', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const p = await w.lead('p');
    const other = await w.lead('other'); await w.attempt(other, w.at(-DAY));
    const pin = (pinnedAt: string, until: string) => w.raw(
      `insert into public.my_leads_strip_overrides(org_id,member_id,property_id,pinned_at,pinned_until) values ($1,$2,$3,$4,$5)
       on conflict (org_id,member_id,property_id) do update set pinned_at=excluded.pinned_at, pinned_until=excluded.pinned_until, hidden_until=null`,
      [w.org, w.sam, p, pinnedAt, until]);
    await pin(w.at(-HOUR), w.at(3 * HOUR));
    expect(w.order(await w.rows())[0]).toBe(p);

    // An outbound text or a note after the pin keeps it; an attempt or outbound call clears it.
    await w.text(p, 'outbound', w.at(-30 * MIN)); await w.note(p, w.at(-20 * MIN));
    expect((await w.rows())[p]).toMatchObject({ tier: 0, pinned: true });
    await w.call(p, 'inbound', w.at(-10 * MIN));
    expect((await w.rows())[p].pinned).toBe(true);
    await w.attempt(p, w.at(-5 * MIN));
    expect((await w.rows())[p]).toMatchObject({ pinned: false });
    expect((await w.rows())[p].tier).not.toBe(0);
    // A call BEFORE the pin does not clear it.
    await w.raw('delete from public.acquisition_attempts where property_id=$1', [p]);
    await pin(w.at(-4 * MIN), w.at(3 * HOUR));
    await w.attempt(p, w.at(-HOUR));
    expect((await w.rows())[p].pinned).toBe(true);
    // An outbound call after the pin clears it.
    await w.call(p, 'outbound', w.at(-1 * MIN));
    expect((await w.rows())[p].pinned).toBe(false);

    // Expiry boundary: pinned until exactly p_at is no longer pinned; one second earlier it is.
    await pin(w.at(-HOUR), w.at(0));
    await w.raw('delete from public.call_activities where property_id=$1', [p]);
    await w.raw('delete from public.acquisition_attempts where property_id=$1', [p]);
    expect((await w.rows())[p].pinned).toBe(false);
    expect((await w.rowsAt(new Date(w.pAt.getTime() - 1000)))[p].pinned).toBe(true);

    // Hide: counted, absent from rows, returns after hidden_until.
    await w.raw('delete from public.my_leads_strip_overrides where property_id=$1', [p]);
    await w.raw('insert into public.my_leads_strip_overrides(org_id,member_id,property_id,hidden_until) values ($1,$2,$3,$4)', [w.org, w.sam, p, w.at(2 * HOUR)]);
    expect((await w.rows())[p]).toMatchObject({ hidden: true });
    expect(w.order(await w.rows())).not.toContain(p);
    const snap = await w.strip10(w.sam);
    expect(snap.hiddenCount).toBe(1);
    expect(snap.rows.map((x: Json) => x.propertyId)).not.toContain(p);
    expect((await w.rowsAt(new Date(w.pAt.getTime() + 2 * HOUR)))[p].hidden).toBe(false);
    // Another member's override on the same lead does not affect this member's strip.
    await w.raw('delete from public.my_leads_strip_overrides where property_id=$1', [p]);
    await w.raw('insert into public.my_leads_strip_overrides(org_id,member_id,property_id,hidden_until) values ($1,$2,$3,$4)', [w.org, w.other, p, w.at(2 * HOUR)]);
    expect((await w.rows())[p].hidden).toBe(false);
  });
});

it('computes "midnight" in America/Chicago across both DST changes and the day boundary', async () => {
  await withDb(async (db) => {
    const mid = async (iso: string) => new Date((await db.query('select public.my_leads_next_chicago_midnight($1::timestamptz) as m', [iso])).rows[0].m).toISOString();
    // Spring forward 2026-03-08 (23-hour day): midnight CST = 06:00Z, next midnight CDT = 05:00Z.
    expect(await mid('2026-03-07T20:00:00Z')).toBe('2026-03-08T06:00:00.000Z');
    expect(await mid('2026-03-08T12:00:00Z')).toBe('2026-03-09T05:00:00.000Z');
    // Fall back 2026-11-01 (25-hour day): midnight CDT = 05:00Z, next midnight CST = 06:00Z.
    expect(await mid('2026-10-31T20:00:00Z')).toBe('2026-11-01T05:00:00.000Z');
    expect(await mid('2026-11-01T12:00:00Z')).toBe('2026-11-02T06:00:00.000Z');
    // Boundary: 23:59:59 CDT is still "today"; midnight itself starts the next day.
    expect(await mid('2026-10-05T04:59:59Z')).toBe('2026-10-05T05:00:00.000Z');
    expect(await mid('2026-10-05T05:00:00Z')).toBe('2026-10-06T05:00:00.000Z');
    // A pin set 23:59:59 CDT expires one second later.
    const w = await world(db);
    const p = await w.lead('p');
    const until = new Date(await mid('2026-10-05T04:59:59Z'));
    await w.raw('insert into public.my_leads_strip_overrides(org_id,member_id,property_id,pinned_at,pinned_until) values ($1,$2,$3,$4,$5)', [w.org, w.sam, p, '2026-10-05T04:59:59Z', until.toISOString()]);
    expect((await w.rowsAt(new Date('2026-10-05T04:59:59Z')))[p].pinned).toBe(true);
    expect((await w.rowsAt(new Date('2026-10-05T05:00:00Z')))[p].pinned).toBe(false);
  });
});

it('the setter pins until Chicago midnight, hides, clears, and refuses outsiders, other members and bad input', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const mine = await w.lead('mine');
    const theirs = await w.lead('theirs', { assignee: w.other });
    const closed = await w.lead('closed');
    await w.raw("update public.properties set status='dead' where id=$1", [closed]);
    const now = Date.now();

    const pinned = await w.setOverride(w.sam, w.sam, mine, 'call_today');
    expect(pinned.ok).toBe(true);
    const until = new Date(pinned.until).getTime();
    expect(until).toBeGreaterThan(now);
    expect(until - now).toBeLessThanOrEqual(25 * HOUR + MIN);
    const expected = (await db.query("select public.my_leads_next_chicago_midnight(now()) as m")).rows[0].m;
    expect(new Date(expected).getTime()).toBe(until);
    const stored = (await db.query('select pinned_at, pinned_until, hidden_until from public.my_leads_strip_overrides where property_id=$1', [mine])).rows[0];
    expect(stored.hidden_until).toBeNull();
    expect(new Date(stored.pinned_until).getTime()).toBe(until);
    expect((await w.strip10(w.sam)).rows[0]).toMatchObject({ propertyId: mine, tier: 0, reason: 'pinned_call_today', pinned: true });

    // Not today replaces the pin with a hide; it leaves the strip and counts as hidden.
    expect((await w.setOverride(w.sam, w.sam, mine, 'not_today')).ok).toBe(true);
    const hidden = (await db.query('select pinned_at, pinned_until, hidden_until from public.my_leads_strip_overrides where property_id=$1', [mine])).rows[0];
    expect(hidden.pinned_until).toBeNull();
    expect(new Date(hidden.hidden_until).getTime()).toBe(until);
    const snap = await w.strip10(w.sam);
    expect(snap.rows.map((x: Json) => x.propertyId)).not.toContain(mine);
    expect(snap.hiddenCount).toBe(1);
    expect((await w.setOverride(w.sam, w.sam, mine, 'clear')).ok).toBe(true);
    expect((await db.query('select count(*)::int n from public.my_leads_strip_overrides')).rows[0].n).toBe(0);

    // Expired rows of this member are removed on the next write.
    await w.raw('insert into public.my_leads_strip_overrides(org_id,member_id,property_id,hidden_until) values ($1,$2,$3,$4)', [w.org, w.sam, mine, new Date(now - HOUR).toISOString()]);
    await w.setOverride(w.sam, w.sam, mine, 'not_today');
    expect((await db.query('select count(*)::int n from public.my_leads_strip_overrides where hidden_until < now()')).rows[0].n).toBe(0);

    await w.expectError(() => w.setOverride(w.sam, w.sam, theirs, 'call_today'), /NOT_FOUND/);
    await w.expectError(() => w.setOverride(w.sam, w.sam, closed, 'call_today'), /NOT_FOUND/);
    await w.expectError(() => w.setOverride(w.sam, w.sam, randomUUID(), 'call_today'), /NOT_FOUND/);
    await w.expectError(() => w.setOverride(w.sam, w.sam, mine, 'snooze'), /INVALID_INPUT/);
    await w.expectError(() => w.setOverride(w.sam, w.sam, mine, ''), /INVALID_INPUT/);
    // Another member cannot write sam's overrides; an owner can read but not write.
    await w.expectError(() => w.setOverride(w.other, w.sam, mine, 'call_today'), /FORBIDDEN/);
    await w.expectError(() => w.setOverride(w.jarrad, w.sam, mine, 'call_today'), /FORBIDDEN/);
    await w.expectError(() => w.as('anon', null, async () => db.query('select public.fn_set_my_leads_strip_override($1,$2,$3,$4)', [w.org, w.sam, mine, 'clear'])), /permission denied/);
    await w.expectError(() => w.as('authenticated', null, async () => db.query('select public.fn_set_my_leads_strip_override($1,$2,$3,$4)', [w.org, w.sam, mine, 'clear'])), /FORBIDDEN/);
    // No direct writes and no direct reads of other members' rows.
    await w.expectError(() => w.as('authenticated', w.sam, async () => db.query('insert into public.my_leads_strip_overrides(org_id,member_id,property_id,hidden_until) values ($1,$2,$3,now())', [w.org, w.sam, mine])), /permission denied/);
    await w.expectError(() => w.as('authenticated', w.sam, async () => db.query('delete from public.my_leads_strip_overrides')), /permission denied/);
    await w.setOverride(w.sam, w.sam, mine, 'not_today');
    expect((await w.as('authenticated', w.sam, async () => db.query('select * from public.my_leads_strip_overrides'))).rows).toHaveLength(1);
    expect((await w.as('authenticated', w.other, async () => db.query('select * from public.my_leads_strip_overrides'))).rows).toHaveLength(0);
  });
});

it('the strip read is scoped, bounded, limited to ten by default, and the internals are not callable', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) { const id = await w.lead(`l${i}`); await w.attempt(id, w.at(-(i + 1) * DAY)); ids.push(id); }
    const snap = await w.strip10(w.sam);
    expect(snap.rows).toHaveLength(10);
    // Longest since touch first.
    expect(snap.rows[0].propertyId).toBe(ids[11]);
    expect(snap.rows[0].row).toMatchObject({ propertyId: ids[11], address: 'l11 Main', stage: 'not_contacted' });
    expect(Object.keys(snap).sort()).toEqual(['excluded', 'hiddenCount', 'rows', 'snapshotAt']);
    expect((await w.strip10(w.sam, w.sam, 3)).rows).toHaveLength(3);
    expect((await w.strip10(w.sam, w.sam, 25)).rows).toHaveLength(12);
    // An owner may read a rep's strip; another member may not.
    expect((await w.strip10(w.jarrad, w.sam)).rows).toHaveLength(10);
    await w.expectError(() => w.strip10(w.other, w.sam), /FORBIDDEN/);
    await w.expectError(() => w.strip10(w.sam, w.sam, 0), /INVALID_INPUT/);
    await w.expectError(() => w.strip10(w.sam, w.sam, 26), /INVALID_INPUT/);
    await w.expectError(() => w.as('anon', null, async () => db.query('select public.fn_get_my_leads_call_next($1,$2)', [w.org, w.sam])), /permission denied/);
    await w.expectError(() => w.as('authenticated', null, async () => db.query('select public.fn_get_my_leads_call_next($1,$2)', [w.org, w.sam])), /FORBIDDEN/);
    for (const call of [
      'select * from public.my_leads_call_next_rows($1,$2,now())',
      'select * from public.my_leads_touch_facts($1,$2,now())',
      "select public.my_leads_next_chicago_midnight(now())",
    ]) {
      await w.expectError(() => w.as('authenticated', w.sam, async () => db.query(call, call.includes('$1') ? [w.org, w.sam] : [])), /permission denied/);
    }
    // The queue ordering function is unchanged by this migration.
    const before = (await db.query('select count(*)::int n from public.my_leads_queue_rows($1,$2,now())', [w.org, w.sam])).rows[0].n;
    expect(before).toBe(12);
  });
});

it('the triage helper lists untouched, next-step-less leads oldest first with keyset paging', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const never1 = await w.lead('never1');
    const never2 = await w.lead('never2');
    const old30 = await w.lead('old30'); await w.attempt(old30, w.at(-30 * DAY));
    const old20 = await w.lead('old20'); await w.text(old20, 'outbound', w.at(-20 * DAY));
    const fresh = await w.lead('fresh'); await w.note(fresh, w.at(-2 * DAY));
    const booked = await w.lead('booked'); await w.appt(booked, w.at(2 * DAY));
    const overdueOnly = await w.lead('overdueOnly'); await w.appt(overdueOnly, w.at(-1 * DAY));
    const dripping = await w.lead('dripping'); await w.drip(dripping);
    const exact = await w.lead('exact'); await w.attempt(exact, w.at(-13 * DAY));

    const triage = (sub: string, args: unknown[] = []) => w.as('authenticated', sub, async () =>
      (await db.query('select public.fn_get_my_leads_triage($1,$2,$3,$4,$5,$6) as r', [w.org, w.sam, ...[14, 25, null, null].map((d, i) => args[i] ?? d)])).rows[0].r as Json);
    const all = await triage(w.sam);
    const got = all.rows.map((r: Json) => r.propertyId);
    expect(got.slice(0, 3).sort()).toEqual([never1, never2, overdueOnly].sort());
    expect(new Set(got)).toEqual(new Set([never1, never2, old30, old20, overdueOnly]));
    expect(got).not.toContain(fresh); expect(got).not.toContain(booked); expect(got).not.toContain(dripping); expect(got).not.toContain(exact);
    expect(got.indexOf(old30)).toBeLessThan(got.indexOf(old20));
    expect(all.totalCount).toBe(5);
    expect(all.cursor).toBeNull();
    expect((await triage(w.sam, [12])).rows.map((r: Json) => r.propertyId)).toContain(exact);

    const page1 = await triage(w.sam, [14, 2]);
    expect(page1.rows).toHaveLength(2);
    expect(page1.cursor).not.toBeNull();
    const page2 = await triage(w.sam, [14, 2, page1.cursor.touch, page1.cursor.property]);
    const page3 = await triage(w.sam, [14, 2, page2.cursor.touch, page2.cursor.property]);
    expect(page3.cursor).toBeNull();
    const paged = [...page1.rows, ...page2.rows, ...page3.rows].map((r: Json) => r.propertyId);
    expect(paged).toEqual(got);
    expect(page1.totalCount).toBe(5);

    await w.expectError(() => triage(w.sam, [0]), /INVALID_INPUT/);
    await w.expectError(() => triage(w.sam, [366]), /INVALID_INPUT/);
    await w.expectError(() => triage(w.sam, [14, 0]), /INVALID_INPUT/);
    await w.expectError(() => triage(w.sam, [14, 51]), /INVALID_INPUT/);
    await w.expectError(() => triage(w.other), /FORBIDDEN/);
    expect((await triage(w.jarrad)).totalCount).toBe(5);   // an owner may read a rep's triage list
  });
});

it('ranks a 400-lead queue inside the 5 second statement timeout', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const ids: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      const id = await w.lead(`v${i}`, { motivation: i % 3 === 0 ? 'hot' : null as unknown as string });
      ids.push(id);
    }
    await db.query("set local session_replication_role='replica'");
    await db.query(`insert into public.acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,occurred_at,idempotency_key,outcome)
      select $1, p, $2, 'outreach','manual', $3::timestamptz - (random()*20 || ' days')::interval, gen_random_uuid(), 'no_answer' from unnest($4::uuid[]) p`, [w.org, w.sam, w.pAt.toISOString(), ids]);
    await db.query(`insert into public.messages(org_id,channel,direction,body,status,property_id,created_at)
      select $1,'sms',case when random()<0.5 then 'inbound' else 'outbound' end,'x','sent', p, $2::timestamptz - (random()*10 || ' days')::interval from unnest($3::uuid[]) p`, [w.org, w.pAt.toISOString(), ids]);
    await db.query("set local session_replication_role='origin'");
    const started = Date.now();
    const snap = await w.strip10(w.sam);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(snap.rows).toHaveLength(10);
  });
});

it('the rollback twin removes every object and leaves no override table behind', async () => {
  await withDb(async (db) => {
    await db.query(rollback);
    const left = (await db.query(`select
      (select count(*)::int from pg_proc where pronamespace='public'::regnamespace and proname in ('fn_get_my_leads_call_next','fn_set_my_leads_strip_override','fn_get_my_leads_triage','my_leads_call_next_rows','my_leads_touch_facts','my_leads_next_chicago_midnight')) as fns,
      to_regclass('public.my_leads_strip_overrides') as t`)).rows[0];
    expect(left.fns).toBe(0);
    expect(left.t).toBeNull();
  });
});
