import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

// My Leads unified queue, Phase B1 (design-owner answers 1-3): the facts object also carries zip, contractSignedAt,
// lastTouch {kind, at} and, on headline rows 4, 9 and 11 (callback_booked), taskKind + snoozed. The database must already hold
// the repo's migrations up to the classifier; this suite re-applies the classifier (old body), snapshots every row, then applies
// its own migration, all inside a rolled-back transaction, so it proves the old keys are untouched and the new ones are right.
const read = (file: string) => {
  const sql = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error(`transaction wrapper changed in ${file}`);
  return sql.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
};
const classifierSql = read('20261015010000_my_leads_work_queue_classifier.sql');
const migrationSql = read('20261015020200_my_leads_work_facts_zip_signed_touch.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Role = 'authenticated' | 'anon' | 'service_role';

// Applies the OLD classifier, hands the caller a way to snapshot, then applies the new migration.
async function withDb(fn: (db: Client, applyNew: () => Promise<void>) => Promise<void>) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await db.query(classifierSql);
    await fn(db, async () => { await db.query(migrationSql); });
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

async function world(db: Client) {
  const org = randomUUID(), jarrad = randomUUID(), sam = randomUUID(), other = randomUUID(), outsider = randomUUID();
  for (const id of [jarrad, sam, other, outsider]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1,'Work queue')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [jarrad, org]);
  for (const id of [sam, other]) await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [id, org]);
  const org2 = randomUUID();
  await db.query("insert into public.organizations(id,name) values ($1,'Other org')", [org2]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [outsider, org2]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled,needs_sequence_owner_id) values ($1,true,$2)', [org, jarrad]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled,needs_sequence_owner_id) values ($1,true,$2)', [org2, outsider]);
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
  const lead = async (key: string, o: { assignee?: string; phone?: boolean; stage?: string; dnc?: boolean; fresh?: boolean } = {}) => {
    const id = randomUUID();
    const assignee = o.assignee ?? sam;
    let contact: string | null = null;
    if (o.phone !== false || o.dnc) {
      contact = randomUUID();
      phoneSeq += 1;
      await db.query('insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values ($1,$2,$3,$4,$5,$6)', [contact, org, key, 'Lead', o.phone === false ? null : `+181655${String(phoneSeq).padStart(5, '0')}`, o.phone === false ? null : 'mobile']);
    }
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id,homeowner_contact_id) values ($1,$2,$3,'MO','new_lead',$4,$5)",
      [id, org, `${key} Main`, assignee, contact]);
    if (o.dnc && contact) {
      await db.query("set local session_replication_role='replica'");
      await db.query('update public.contacts set do_not_contact=true where id=$1', [contact]);
      await db.query("set local session_replication_role='origin'");
    }
    if (o.stage) await setStage(id, o.stage);
    // Most fixtures want a lead that has been worked once, so it is not a brand-new lead by accident.
    if (!o.fresh) await attempt(id, new Date(pAt.getTime() - 30 * DAY).toISOString());
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
  const attempt = (property: string, when: string, outcome = 'no_answer') => raw(
    "insert into public.acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,occurred_at,recorded_at,idempotency_key,outcome) values ($1,$2,$3,'outreach','manual',$4,$4,$5,$6)",
    [org, property, sam, when, randomUUID(), outcome]);
  const text = async (property: string, direction: 'inbound' | 'outbound', when: string,
    o: { status?: string; contactOnly?: boolean; meta?: Json; campaign?: boolean; scheduledFor?: string; id?: string; sentAt?: string } = {}) => {
    const contact = (await db.query('select homeowner_contact_id as c from public.properties where id=$1', [property])).rows[0].c;
    const id = o.id ?? randomUUID();
    await raw(`insert into public.messages(id,org_id,channel,direction,body,status,property_id,contact_id,created_at,metadata,campaign_id,scheduled_for,sent_at)
               values ($1,$2,'sms',$3,'hi',$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, org, direction, o.status ?? (direction === 'inbound' ? 'received' : 'sent'), o.contactOnly ? null : property, contact, when,
       JSON.stringify(o.meta ?? {}), o.campaign ? randomUUID() : null, o.scheduledFor ?? null, o.sentAt ?? null]);
    return id;
  };
  const note = (property: string, when: string) => raw('insert into public.lead_notes(org_id,property_id,author_user_id,body,created_at) values ($1,$2,$3,$4,$5)', [org, property, sam, 'note', when]);
  const call = async (property: string, direction: 'inbound' | 'outbound', started: string, o: { ended?: boolean; talk?: number } = {}) => {
    const contact = (await db.query('select homeowner_contact_id as c from public.properties where id=$1', [property])).rows[0].c;
    await raw('insert into public.call_activities(org_id,property_id,contact_id,jitter_attempt_id,jitter_session_id,direction,started_at,ended_at,talk_duration_seconds) values ($1,$2,$3,$4,$4,$5,$6,$7,$8)',
      [org, property, contact, randomUUID(), direction, started, o.ended === false ? null : started, o.talk ?? 0]);
  };
  const appt = async (property: string, due: string, o: { type?: string; status?: string; chain?: string; snoozedUntil?: string; sourceKey?: string } = {}) => {
    const type = o.type ?? 'appointment';
    const status = o.status ?? 'open';
    const chainId = type === 'appointment' ? (o.chain ?? randomUUID()) : null;
    const end = type === 'appointment' ? new Date(new Date(due).getTime() + 15 * MIN).toISOString() : null;
    const outcome = type === 'appointment' && (status === 'completed' || status === 'cancelled') ? (status === 'completed' ? 'held' : 'cancelled') : null;
    await raw(
      'insert into public.tasks(org_id,type,status,title,due_at,end_at,assignee_id,created_by,calendar_chain_id,related_property_id,snoozed_until,outcome,source_key) values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12)',
      [org, type, status, `${type} task`, due, end, sam, chainId, property, o.snoozedUntil ?? null, outcome, o.sourceKey ?? null]);
    return chainId;
  };
  const offer = async (property: string, o: { sentAt?: string; followUpAt: string; chain?: string | null; outcome?: string }) => {
    await raw(
      `insert into public.acquisition_offers(org_id,property_id,actor_user_id,amount_cents,sent_via,sent_at,follow_up_at,outcome,idempotency_key,follow_up_calendar_chain_id)
       values ($1,$2,$3,150000,'verbal',$4,$5,$6,$7,$8)`,
      [org, property, sam, o.sentAt ?? at(-3 * DAY), o.followUpAt, o.outcome ?? 'pending', randomUUID(), o.chain ?? null]);
  };
  // A drip: sequence + steps + enrollment. status/pause/next/updated are written as given.
  const drip = async (property: string, o: { status?: string; pause?: string | null; next?: string | null; updated?: string; steps?: number; idx?: number; by?: string; enrolledAt?: string; completedAt?: string } = {}) => {
    const seq = randomUUID(), enr = randomUUID();
    const total = o.steps ?? 4;
    await raw('insert into public.sequences(id,org_id,name) values ($1,$2,$3)', [seq, org, `Warm check-in ${seq.slice(0, 4)}`]);
    const steps: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const id = randomUUID();
      steps.push(id);
      await raw("insert into public.sequence_steps(id,sequence_id,step_index,action_type,template_body) values ($1,$2,$3,'send_sms','hello')", [id, seq, i]);
    }
    await raw(
      `insert into public.sequence_enrollments(id,org_id,sequence_id,property_id,status,current_step_index,next_run_at,pause_reason,updated_at,enrolled_by_user_id,enrolled_at,completed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [enr, org, seq, property, o.status ?? 'active', o.idx ?? 0, o.next === undefined ? at(HOUR) : o.next, o.pause ?? null, o.updated ?? at(-MIN), o.by ?? null, o.enrolledAt ?? at(-5 * DAY), o.completedAt ?? null]);
    return { seq, enr, steps };
  };
  const dripText = async (property: string, d: { enr: string; steps: string[] }, step: number, when: string) => {
    const id = await text(property, 'outbound', when);
    await raw('insert into public.sequence_step_runs(enrollment_id,step_id,message_id,scheduled_for,run_at) values ($1,$2,$3,$4,$4)', [d.enr, d.steps[step], id, when]);
    return id;
  };
  const staleClaim = (enr: string, step: string, startedAt: string) => raw(
    "insert into public.sequence_step_runs(enrollment_id,step_id,scheduled_for,claim_active,attempt_outcome,attempt_started_at) values ($1,$2,$3,true,'unknown',$3)", [enr, step, startedAt]);
  const ledger = async (property: string, state: string, updated: string, o: { messageId?: string } = {}) => {
    const contact = (await db.query('select homeowner_contact_id as c from public.properties where id=$1', [property])).rows[0].c;
    const id = randomUUID();
    await raw(
      `insert into public.rep_sms_delivery_ledger(id,org_id,actor_user_id,submission_key,property_id,contact_id,sender_assignment_id,provider,provider_account_id,provider_sender_id,from_number,to_number,body,state,claim_token,message_id,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,'sendillo','acct','sender','+18165550100','+18165550101','hi',$8,$9,$10,$11,$11)`,
      [id, org, sam, randomUUID(), property, contact, randomUUID(), state, randomUUID(), o.messageId ?? null, updated]);
    return id;
  };
  const obligation = async (property: string, state: string, updated: string, o: { lease?: string } = {}) => {
    const id = randomUUID();
    const claimed = state === 'claimed' || state === 'sending';
    const complete = ['accepted', 'delivered', 'delivery_failed', 'voided', 'exception_closed'].includes(state);
    const authorized = ['sending', 'accepted', 'delivered', 'unknown', 'delivery_failed'].includes(state);
    await raw(
      `insert into public.rep_sms_obligations(id,org_id,property_id,attempt_id,actor_user_id,state,claim_state,claim_token,claimed_by,claimed_at,lease_expires_at,authorized_at,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
      [id, org, property, randomUUID(), sam, state, claimed ? 'claimed' : complete ? 'complete' : 'unclaimed',
       claimed || complete ? randomUUID() : null, claimed ? sam : null, claimed ? updated : null, claimed ? (o.lease ?? updated) : null,
       authorized ? updated : null, updated]);
    return id;
  };
  const aiDraft = (property: string, when: string) => raw("insert into public.ai_reply_drafts(org_id,property_id,body,source,status,created_at) values ($1,$2,'draft','llm','pending',$3)", [org, property, when]);
  const deadLetter = (property: string, when: string) => raw("insert into public.ai_reply_dead_letters(org_id,property_id,body,reason,created_at) values ($1,$2,'x','failed',$3)", [org, property, when]);
  const norma = (property: string, status: string, when: string) => raw(
    "insert into public.norma_call_requests(org_id,property_id,phone_e164,callback_assignee_id,status,created_at,updated_at) values ($1,$2,'+18165550102',$3,$4,$5,$5)", [org, property, sam, status, when]);
  const event = (property: string, type: string, when: string, o: { actor?: string; payload?: Json; sourceId?: string } = {}) => raw(
    'insert into public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [org, property, o.actor ?? 'user', (o.actor ?? 'user') === 'user' ? sam : null, type, JSON.stringify(o.payload ?? {}), o.sourceId ? 'rep_sms' : null, o.sourceId ?? null, when]);
  // A pin with no expiry is the Phase B shape (that migration makes pinned_until nullable). Until it lands the check
  // constraint forbids it, so the classifier's read predicate is exercised by dropping the check in this rolled-back transaction.
  const pin = async (property: string, pinnedAt: string, until: string | null) => {
    if (until === null) await raw('alter table public.my_leads_strip_overrides drop constraint if exists my_leads_strip_overrides_one_kind_check', []);
    await raw('insert into public.my_leads_strip_overrides(org_id,member_id,property_id,pinned_at,pinned_until) values ($1,$2,$3,$4,$5)', [org, sam, property, pinnedAt, until]);
  };
  const setAssigned = (property: string, when: string) => raw('update public.acquisition_assignment_episodes set assigned_at=$2 where property_id=$1 and ended_at is null', [property, when]);

  const classified = async (when: Date = pAt, member = sam): Promise<Record<string, Json>> => {
    const r = (await db.query('select * from public.my_leads_work_classified($1,$2,$3)', [org, member, when.toISOString()])).rows;
    return Object.fromEntries(r.map((x) => [x.property_id, x]));
  };
  const one = async (id: string, when: Date = pAt) => {
    const row = (await classified(when))[id];
    if (!row) throw new Error(`lead ${id} is not in the queue`);
    return row;
  };
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
  const page = (sub: string, o: { member?: string; tab?: string; chip?: string | null; stage?: string | null; search?: string | null; page?: number; size?: number; when?: Date; orgId?: string } = {}) =>
    as('authenticated', sub, async () => (await db.query('select public.fn_my_leads_work_page($1,$2,$3,$4,$5,$6,$7,$8,$9) as r',
      [o.orgId ?? org, o.member ?? sam, o.tab ?? 'needs_attention', o.chip ?? null, o.stage ?? null, o.search ?? null, o.page ?? 1, o.size ?? 25, (o.when ?? pAt).toISOString()])).rows[0].r as Json);
  const facts = (sub: string, ids: string[], member = sam, when: Date = pAt) =>
    as('authenticated', sub, async () => (await db.query('select public.fn_my_leads_work_facts($1,$2,$3,$4) as r', [org, member, ids, when.toISOString()])).rows[0].r as Json);
  const badge = (sub: string, when: Date = pAt) =>
    as('authenticated', sub, async () => (await db.query('select public.fn_my_leads_badge_v2($1) as r', [when.toISOString()])).rows[0].r as number);
  return { org, org2, jarrad, sam, other, outsider, pAt, at, lead, setStage, attempt, text, note, call, appt, offer, drip, dripText, staleClaim, ledger, obligation,
    aiDraft, deadLetter, norma, event, pin, setAssigned, classified, one, as, expectError, page, facts, badge, raw };
}
type World = Awaited<ReturnType<typeof world>>;

const rows = async (w: World, db: Client, when: Date = w.pAt): Promise<Record<string, Json>> => w.classified(when);
const newKeys = ['zip', 'contractSignedAt', 'lastTouch'];

it('is additive: every pre-existing column and facts key is identical before and after, for a spread of placements', async () => {
  await withDb(async (db, applyNew) => {
    const w = await world(db);
    const ids: string[] = [];
    ids.push(await w.lead('fresh', { fresh: true }));
    ids.push(await w.lead('uc', { stage: 'under_contract' }));
    const due = await w.lead('due'); await w.appt(due, w.at(-5 * MIN), { type: 'callback' }); ids.push(due);
    const soon = await w.lead('soon'); await w.appt(soon, w.at(10 * MIN)); ids.push(soon);
    const missed = await w.lead('missed'); await w.appt(missed, w.at(-9 * DAY), { type: 'callback' }); ids.push(missed);
    const booked = await w.lead('booked'); await w.appt(booked, w.at(2 * DAY)); ids.push(booked);
    const reply = await w.lead('reply'); await w.text(reply, 'inbound', w.at(-2 * HOUR)); ids.push(reply);
    const sent = await w.lead('sent'); await w.text(sent, 'outbound', w.at(-HOUR)); ids.push(sent);
    const quiet = await w.lead('quiet'); await w.text(quiet, 'outbound', w.at(-6 * DAY)); ids.push(quiet);
    const dripLead = await w.lead('drip'); await w.drip(dripLead); ids.push(dripLead);
    const broken = await w.lead('broken'); await w.text(broken, 'outbound', w.at(-HOUR), { status: 'failed' }); ids.push(broken);
    const plain = await w.lead('plain'); ids.push(plain);
    const before = await rows(w, db);
    await applyNew();
    const after = await rows(w, db);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const id of ids) {
      const { facts: bf, ...b } = before[id];
      const { facts: af, ...a } = after[id];
      expect(a, id).toEqual(b);
      const strip = (f: Json) => {
        const { zip, contractSignedAt, lastTouch, ...rest } = f;
        void zip; void contractSignedAt; void lastTouch;
        const headline = { ...rest.headline }; delete headline.taskKind; delete headline.snoozed;
        return { ...rest, headline };
      };
      expect(strip(af), id).toEqual(strip(bf));
      for (const k of newKeys) expect(Object.keys(af), id).toContain(k);
      expect(Object.keys(bf)).not.toContain('zip');
    }
  });
});

it('zip: present is returned trimmed, blank and null come back null', async () => {
  await withDb(async (db, applyNew) => {
    const w = await world(db);
    const a = await w.lead('a'), b = await w.lead('b'), c = await w.lead('c');
    await db.query('update public.properties set zip=$2 where id=$1', [a, ' 64111 ']);
    await db.query('update public.properties set zip=$2 where id=$1', [b, '   ']);
    await applyNew();
    const r = await rows(w, db);
    expect(r[a].facts.zip).toBe('64111');
    expect(r[b].facts.zip).toBeNull();
    expect(r[c].facts.zip).toBeNull();
    expect('zip' in r[c].facts).toBe(true);
    const viaWrapper = await w.facts(w.sam, [a, b]);
    expect(new Set(viaWrapper.rows.map((x: Json) => x.zip))).toEqual(new Set([null, '64111']));
  });
});

it('contractSignedAt: the recorded signed date for an under-contract lead, null when none is recorded', async () => {
  await withDb(async (db, applyNew) => {
    const w = await world(db);
    const signed = await w.lead('signed', { stage: 'under_contract' });
    const unknown = await w.lead('unknown', { stage: 'under_contract' });
    const notYet = await w.lead('notyet');
    const when = w.at(-3 * DAY);
    await db.query('update public.acquisition_queue_states set signed_at=$2, signed_by=$3 where property_id=$1', [signed, when, w.sam]);
    await applyNew();
    const r = await rows(w, db);
    expect(r[signed].row_no).toBe('1');
    expect(new Date(r[signed].facts.contractSignedAt).toISOString()).toBe(when);
    expect(r[unknown].facts.contractSignedAt).toBeNull();
    expect(r[notYet].facts.contractSignedAt).toBeNull();
  });
});

it('lastTouch: kind follows the source of the greatest-timestamp touch; null when there is none; at equals lastTouchAt', async () => {
  await withDb(async (db, applyNew) => {
    const w = await world(db);
    const mk = async (key: string, build: (id: string) => Promise<unknown>) => { const id = await w.lead(key); await build(id); return id; };
    const t = (ms: number) => w.at(ms);
    const human = await mk('human', (id) => w.text(id, 'outbound', t(-HOUR)));
    const ai = await mk('ai', (id) => w.text(id, 'outbound', t(-HOUR), { meta: { generated_by: 'ai_responder_v1' } }));
    const campaign = await mk('campaign', (id) => w.text(id, 'outbound', t(-HOUR), { campaign: true }));
    const dripLead = await mk('drip', async (id) => { const d = await w.drip(id); await w.dripText(id, d, 0, t(-HOUR)); });
    const reached = await mk('reached', (id) => w.attempt(id, t(-HOUR), 'reached'));
    const noAnswer = await mk('noanswer', (id) => w.attempt(id, t(-HOUR), 'no_answer'));
    const voicemail = await mk('vm', (id) => w.attempt(id, t(-HOUR), 'voicemail'));
    const note = await mk('note', (id) => w.note(id, t(-HOUR)));
    const callTalk = await mk('calltalk', (id) => w.call(id, 'outbound', t(-HOUR), { talk: 120 }));
    const callNone = await mk('callnone', (id) => w.call(id, 'outbound', t(-HOUR), { talk: 0 }));
    const old = await mk('old', async (id) => { await w.text(id, 'outbound', t(-5 * DAY)); await w.note(id, t(-DAY)); });   // note is later than the text
    const tieTextVsAttempt = await mk('tie1', async (id) => { await w.text(id, 'outbound', t(-HOUR)); await w.attempt(id, t(-HOUR), 'reached'); });
    const tieAttemptVsNote = await mk('tie2', async (id) => { await w.attempt(id, t(-HOUR), 'voicemail'); await w.note(id, t(-HOUR)); });
    const ignoredInbound = await mk('inbound', (id) => w.text(id, 'inbound', t(-30 * MIN)));   // a seller text is not a touch; the 30-day-old attempt is
    const failedText = await mk('failed', (id) => w.text(id, 'outbound', t(-30 * MIN), { status: 'failed' }));   // a failed text is not a touch
    const none = await w.lead('none', { fresh: true });
    await applyNew();
    const r = await rows(w, db);
    const kind = (id: string) => r[id].facts.lastTouch?.kind;
    expect(kind(human)).toBe('your_text');
    expect(kind(ai)).toBe('sandra_reply');
    expect(kind(campaign)).toBe('campaign_text');
    expect(kind(dripLead)).toBe('drip_text');
    expect(kind(reached)).toBe('call_reached');
    expect(kind(noAnswer)).toBe('call_no_answer');
    expect(kind(voicemail)).toBe('voicemail');
    expect(kind(note)).toBe('note');
    expect(kind(callTalk)).toBe('call_reached');
    expect(kind(callNone)).toBe('call_no_answer');
    expect(kind(old)).toBe('note');
    expect(kind(tieTextVsAttempt)).toBe('your_text');
    expect(kind(tieAttemptVsNote)).toBe('voicemail');
    expect(kind(ignoredInbound)).toBe('call_no_answer');
    expect(kind(failedText)).toBe('call_no_answer');
    expect(r[none].facts.lastTouch).toBeNull();
    expect(r[none].facts.lastTouchAt).toBeNull();
    for (const id of [human, ai, campaign, dripLead, reached, voicemail, note, old, tieAttemptVsNote]) {
      expect(new Date(r[id].facts.lastTouch.at).getTime(), id).toBe(new Date(r[id].facts.lastTouchAt).getTime());
    }
  });
});

it('lastTouch: an outbound text is timed by when it was sent, not created (campaign created Monday, sent Thursday beats a Wednesday note)', async () => {
  await withDb(async (db, applyNew) => {
    const w = await world(db);
    const t = (ms: number) => w.at(ms);
    const straddle = await w.lead('straddle');
    await w.text(straddle, 'outbound', t(-4 * DAY), { campaign: true, sentAt: t(-DAY) });   // created Monday, sent Thursday
    await w.note(straddle, t(-2 * DAY));                                                    // Wednesday
    const earlySend = await w.lead('earlysend');
    await w.text(earlySend, 'outbound', t(-4 * DAY), { campaign: true, sentAt: t(-3 * DAY) });
    await w.note(earlySend, t(-2 * DAY));                                                   // the note is later than the send
    await applyNew();
    const r = await rows(w, db);
    const at = (id: string) => new Date(r[id].facts.lastTouch.at).getTime();
    expect(r[straddle].facts.lastTouch.kind).toBe('campaign_text');
    expect(r[earlySend].facts.lastTouch.kind).toBe('note');
    // kind and at come from the same source: the straddle lead's touch is its send time (Thursday), not the created_at-based lastTouchAt.
    expect(at(straddle)).toBe(new Date(t(-DAY)).getTime());
    expect(at(earlySend)).toBe(new Date(t(-2 * DAY)).getTime());
    // the legacy key keeps its created_at-based value (ranking unchanged)
    expect(new Date(r[straddle].facts.lastTouchAt).getTime()).not.toBeNaN();
  });
});

it('taskKind/snoozed: rows 4, 9 and 11 (callback_booked) carry the kind and snooze state of the earliest task behind the headline time', async () => {
  await withDb(async (db, applyNew) => {
    const w = await world(db);
    const dueCallback = await w.lead('duecb'); await w.appt(dueCallback, w.at(-5 * MIN), { type: 'callback' });
    const dueAppt = await w.lead('dueappt'); await w.appt(dueAppt, w.at(5 * MIN));
    // earliest wins: a later callback must not hide an earlier appointment, and vice versa
    const mixed = await w.lead('mixed'); await w.appt(mixed, w.at(-2 * HOUR)); await w.appt(mixed, w.at(-HOUR), { type: 'callback' });
    const dueSnoozed = await w.lead('duesnz'); await w.appt(dueSnoozed, w.at(-5 * DAY), { type: 'callback', status: 'snoozed', snoozedUntil: w.at(-10 * MIN) });
    const missed = await w.lead('missed'); await w.appt(missed, w.at(-9 * DAY), { type: 'callback' });
    const booked = await w.lead('booked'); await w.appt(booked, w.at(2 * DAY), { type: 'callback' });
    const bookedSnoozed = await w.lead('bookedsnz'); await w.appt(bookedSnoozed, w.at(-HOUR), { type: 'callback', status: 'snoozed', snoozedUntil: w.at(DAY) });
    const bookedAppt = await w.lead('bookedappt'); await w.appt(bookedAppt, w.at(3 * DAY));
    const quiet = await w.lead('quiet');
    await applyNew();
    const r = await rows(w, db);
    const h = (id: string) => r[id].facts.headline;
    expect(r[dueCallback].row_no).toBe('4'); expect(h(dueCallback)).toMatchObject({ taskKind: 'callback', snoozed: false });
    expect(r[dueAppt].row_no).toBe('4'); expect(h(dueAppt)).toMatchObject({ taskKind: 'appointment', snoozed: false, soon: true });
    expect(r[mixed].row_no).toBe('4'); expect(h(mixed)).toMatchObject({ taskKind: 'appointment', snoozed: false });
    expect(r[dueSnoozed].row_no).toBe('4'); expect(h(dueSnoozed)).toMatchObject({ taskKind: 'callback', snoozed: true });
    expect(r[missed].row_no).toBe('9'); expect(h(missed)).toMatchObject({ taskKind: 'callback', snoozed: false });
    expect(r[booked].row_no).toBe('11'); expect(h(booked)).toMatchObject({ kind: 'callback_booked', taskKind: 'callback', snoozed: false });
    expect(r[bookedSnoozed].row_no).toBe('11'); expect(h(bookedSnoozed)).toMatchObject({ kind: 'callback_booked', taskKind: 'callback', snoozed: true });
    expect(r[bookedAppt].row_no).toBe('11'); expect(h(bookedAppt)).toMatchObject({ taskKind: 'appointment', snoozed: false });
    expect(Object.keys(h(quiet))).not.toContain('taskKind');
  });
});

it('taskKind is not added to offer_out (row 11/12) or other headlines', async () => {
  await withDb(async (db, applyNew) => {
    const w = await world(db);
    const chain = randomUUID();
    const o = await w.lead('offer', { stage: 'offer_sent' });
    await w.appt(o, w.at(DAY), { chain });
    await w.offer(o, { followUpAt: w.at(DAY), chain });
    const plain = await w.lead('plain');
    await applyNew();
    const r = await rows(w, db);
    expect(r[o].facts.headline).not.toHaveProperty('taskKind');
    expect(r[plain].facts.headline).not.toHaveProperty('taskKind');
    expect(r[plain].facts.headline).not.toHaveProperty('snoozed');
  });
});

it('the page and facts RPCs surface the new keys, and the migration leaves them read-only', async () => {
  await withDb(async (db, applyNew) => {
    const w = await world(db);
    const id = await w.lead('rpc');
    await db.query('update public.properties set zip=$2 where id=$1', [id, '64108']);
    await w.note(id, w.at(-HOUR));
    await applyNew();
    const page = await w.page(w.sam, { tab: 'all' });
    const row = page.rows.find((x: Json) => x.propertyId === id);
    expect(row.zip).toBe('64108');
    expect(row.lastTouch.kind).toBe('note');
    const f = await w.facts(w.sam, [id]);
    expect(f.rows[0].zip).toBe('64108');
    expect(f.rows[0].lastTouch.kind).toBe('note');
  });
});

it('unknown ledger/obligation states are in flight for 15 minutes, then Broken (design 2.1 v9)', async () => {
  await withDb(async (db, applyNew) => {
    const w = await world(db);
    const l10 = await w.lead('l10'), l16 = await w.lead('l16'), o10 = await w.lead('o10'), o16 = await w.lead('o16');
    await w.ledger(l10, 'unknown', w.at(-10 * MIN));
    await w.ledger(l16, 'unknown', w.at(-16 * MIN));
    await w.obligation(o10, 'unknown', w.at(-10 * MIN));
    await w.obligation(o16, 'unknown', w.at(-16 * MIN));
    await applyNew();
    const kinds = (r: Record<string, Json>, id: string) => (r[id].facts.broken as Json[]).map((b) => b.kind);
    const now = await rows(w, db);
    expect(kinds(now, l10)).toEqual([]);
    expect(kinds(now, o10)).toEqual([]);
    expect(kinds(now, l16)).toEqual(['text_status_unknown']);
    expect(kinds(now, o16)).toEqual(['followup_text_status_unknown']);
    // The clock alone turns the 10-minute ones Broken: next_change_at lands 1 ms past the 15-minute threshold.
    const boundary = new Date(w.pAt.getTime() + 5 * MIN + 1);
    for (const id of [l10, o10]) expect(new Date(now[id].next_change_at).getTime()).toBeLessThanOrEqual(boundary.getTime());
    const later = await rows(w, db, boundary);
    expect(kinds(later, l10)).toEqual(['text_status_unknown']);
    expect(kinds(later, o10)).toEqual(['followup_text_status_unknown']);
  });
});

it('norma_needs_review carries the needs_review request id as refId', async () => {
  await withDb(async (db, applyNew) => {
    const w = await world(db);
    const id = await w.lead('norma');
    await w.norma(id, 'needs_review', w.at(-3 * HOUR));
    await applyNew();
    const oldest = (await db.query("select id from public.norma_call_requests where property_id=$1 and status='needs_review'", [id])).rows[0].id;
    const items = ((await rows(w, db))[id].facts.broken as Json[]).filter((b) => b.kind === 'norma_needs_review');
    expect(items).toHaveLength(1);
    expect(items[0].refId).toBe(oldest);
  });
});

it('up, down, up applies cleanly in a rolled-back transaction', async () => {
  await withDb(async (db, applyNew) => {
    const w = await world(db);
    const id = await w.lead('cycle');
    await db.query('update public.properties set zip=$2 where id=$1', [id, '64108']);
    await applyNew();
    expect((await rows(w, db))[id].facts.zip).toBe('64108');
    await db.query(read('../rollbacks/20261015020200_my_leads_work_facts_zip_signed_touch.sql'));
    expect(Object.keys((await rows(w, db))[id].facts)).not.toContain('zip');
    await applyNew();
    expect((await rows(w, db))[id].facts.zip).toBe('64108');
  });
});
