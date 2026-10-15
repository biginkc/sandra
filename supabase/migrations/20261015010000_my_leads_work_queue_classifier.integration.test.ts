import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

// Design v7 (My Leads unified work queue), Phase A1: one named fixture per decision-table row
// (1.1) and per scenario row (section 8), plus the invariants. The database must already hold the
// repo's migrations (CI's disposable database does; a local one needs `supabase db reset` or the
// pending migrations applied); this suite then re-applies its own migration inside a rolled-back
// transaction, so it always tests the SQL in this checkout.
const migration = (() => {
  const sql = readFileSync(new URL('./20261015010000_my_leads_work_queue_classifier.sql', import.meta.url), 'utf8');
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error('transaction wrapper changed');
  const strip = (t: string) => t.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
  // Later migrations that replace the classifier, applied after this one by the shipped-body variant
  // (20261015030000_my_leads_work_classified_perf.integration.test.ts); empty for this suite on its own.
  const extra = (process.env.MY_LEADS_CLASSIFIER_EXTRA_MIGRATIONS ?? '').split(',').filter(Boolean)
    .map((f) => strip(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')));
  return [strip(sql), ...extra].join('\n;\n');
})();
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NIL = '00000000-0000-0000-0000-000000000000';
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
    await db.query(migration);
    await fn(db);
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

// ---- fixtures -------------------------------------------------------------------------------------------
type Expect = { place: string; reason: string; row: string; labels?: string[]; headline?: Json; brokenKinds?: string[]; at?: (w: World) => Date };
function fixture(name: string, build: (w: World) => Promise<string>, expected: Expect) {
  it(name, async () => {
    await withDb(async (db) => {
      const w = await world(db);
      const id = await build(w);
      const r = await w.one(id, expected.at ? expected.at(w) : w.pAt);
      expect({ place: r.place, reason: r.reason, row: r.row_no }, JSON.stringify(r.facts.headline)).toEqual({ place: expected.place, reason: expected.reason, row: expected.row });
      if (expected.labels) expect([...r.labels].sort()).toEqual([...expected.labels].sort());
      if (expected.headline) expect(r.facts.headline).toMatchObject(expected.headline);
      if (expected.brokenKinds) expect(r.facts.broken.map((b: Json) => b.kind).sort()).toEqual([...expected.brokenKinds].sort());
    });
  });
}
const NA = 'your_move', WT = 'their_move', NE = 'neither';
const iso = (s: string) => new Date(s);
const plus1ms = (t: string) => new Date(new Date(t).getTime() + 1).toISOString();

// Decision table rows (1.1)
fixture('D1 under contract with nothing due is Neither (All leads only)', async (w) => w.lead('uc', { stage: 'under_contract' }), { place: NE, reason: 'under_contract', row: '1' });
fixture('D1 under contract with a callback in 10 min is Due (row 1 yields to row 4)', async (w) => {
  const id = await w.lead('uc', { stage: 'under_contract' }); await w.appt(id, w.at(10 * MIN)); return id;
}, { place: NA, reason: 'due', row: '4' });
fixture('D1 under contract with a callback tomorrow is Waiting · Callback booked', async (w) => {
  const id = await w.lead('uc', { stage: 'under_contract' }); await w.appt(id, w.at(DAY)); return id;
}, { place: WT, reason: 'callback_booked', row: '11' });
fixture('D1 under contract with a snoozed callback is not Neither', async (w) => {
  const id = await w.lead('uc', { stage: 'under_contract' }); await w.appt(id, w.at(-HOUR), { status: 'snoozed', snoozedUntil: w.at(2 * DAY) }); return id;
}, { place: WT, reason: 'callback_booked', row: '11' });
fixture('D2 Call today pin without expiry', async (w) => {
  const id = await w.lead('pin'); await w.pin(id, w.at(-2 * HOUR), null); return id;
}, { place: NA, reason: 'call_today', row: '2' });
fixture('D2 Call today pin before its midnight expiry', async (w) => {
  const id = await w.lead('pin'); await w.pin(id, w.at(-2 * HOUR), w.at(3 * HOUR)); return id;
}, { place: NA, reason: 'call_today', row: '2' });
fixture('D2 an expired pin no longer counts', async (w) => {
  const id = await w.lead('pin'); await w.pin(id, w.at(-9 * HOUR), w.at(-HOUR)); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('D2 / Call today pinned, then call logged: leaves Call today', async (w) => {
  const id = await w.lead('pin'); await w.pin(id, w.at(-2 * HOUR), null); await w.attempt(id, w.at(-HOUR)); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('D2 a note or text after the pin does not unpin', async (w) => {
  const id = await w.lead('pin'); await w.pin(id, w.at(-2 * HOUR), null); await w.note(id, w.at(-HOUR)); return id;
}, { place: NA, reason: 'call_today', row: '2' });
fixture('D3 / Assigned today, never called', async (w) => w.lead('new', { fresh: true }), { place: NA, reason: 'new_lead', row: '3', headline: { firstCallOverdue: false } });
fixture('D3 / Assigned, past first-call window', async (w) => {
  const id = await w.lead('new', { fresh: true }); await w.setAssigned(id, w.at(-4 * DAY)); return id;
}, { place: NA, reason: 'new_lead', row: '3', headline: { firstCallOverdue: true } });
fixture('D4 callback due in 10 minutes is Due soon', async (w) => {
  const id = await w.lead('due'); await w.appt(id, w.at(10 * MIN)); return id;
}, { place: NA, reason: 'due', row: '4', headline: { soon: true } });
fixture('D4 callback overdue 6 days is still Due', async (w) => {
  const id = await w.lead('due'); await w.appt(id, w.at(-6 * DAY)); return id;
}, { place: NA, reason: 'due', row: '4', headline: { soon: false } });
fixture('D4 a legacy callback task counts as a callback', async (w) => {
  const id = await w.lead('due'); await w.appt(id, w.at(-HOUR), { type: 'callback' }); return id;
}, { place: NA, reason: 'due', row: '4' });
fixture('D5 unanswered inbound text is New reply', async (w) => {
  const id = await w.lead('reply'); await w.text(id, 'inbound', w.at(-3 * HOUR)); return id;
}, { place: NA, reason: 'new_reply', row: '5', headline: { kind: 'text' } });
fixture('D5 unanswered missed inbound call is New reply', async (w) => {
  const id = await w.lead('reply'); await w.call(id, 'inbound', w.at(-2 * HOUR)); return id;
}, { place: NA, reason: 'new_reply', row: '5', headline: { kind: 'call' } });
fixture('D5 contact-only inbound is New reply with the check-texts label', async (w) => {
  const id = await w.lead('reply'); await w.text(id, 'inbound', w.at(-2 * HOUR), { contactOnly: true }); return id;
}, { place: NA, reason: 'new_reply', row: '5', labels: ['check_texts'] });
fixture('D6 drip provider_failed is Broken', async (w) => {
  const id = await w.lead('broken'); await w.drip(id, { status: 'paused', pause: 'provider_failed', next: null, idx: 1 }); return id;
}, { place: NA, reason: 'broken', row: '6', brokenKinds: ['drip_paused'] });
fixture('D6a manual queued rep text with no schedule', async (w) => {
  const id = await w.lead('queued'); await w.text(id, 'outbound', w.at(-HOUR), { status: 'queued' }); return id;
}, { place: NA, reason: 'nothing_planned', row: '6a', labels: ['text_waiting'], headline: { variant: 'text_waiting' } });
fixture('D7 ready for an offer, none logged', async (w) => w.lead('ready', { stage: 'needs_offer' }), { place: NA, reason: 'offer', row: '7', headline: { kind: 'ready' } });
fixture('D8 pending offer, follow-up due', async (w) => {
  const id = await w.lead('offer', { stage: 'offer_sent' }); await w.offer(id, { followUpAt: w.at(-HOUR) }); return id;
}, { place: NA, reason: 'offer', row: '8', headline: { kind: 'follow_up_due' } });
fixture('D9 missed callback 9 days overdue', async (w) => {
  const id = await w.lead('missed'); await w.appt(id, w.at(-9 * DAY)); return id;
}, { place: NA, reason: 'due', row: '9', headline: { overdueDays: 9 } });
fixture('D10 healthy drip', async (w) => {
  const id = await w.lead('drip'); await w.drip(id); return id;
}, { place: WT, reason: 'in_drip', row: '10' });
fixture('D11 future callback', async (w) => {
  const id = await w.lead('cb'); await w.appt(id, w.at(3 * HOUR)); return id;
}, { place: WT, reason: 'callback_booked', row: '11' });
fixture('D12 offer out', async (w) => {
  const id = await w.lead('offer', { stage: 'offer_sent' }); const chain = await w.appt(id, w.at(5 * DAY)); await w.offer(id, { followUpAt: w.at(5 * DAY), chain }); return id;
}, { place: WT, reason: 'offer_out', row: '12' });
fixture('D13 texted last', async (w) => {
  const id = await w.lead('texted'); await w.text(id, 'outbound', w.at(-3 * HOUR)); return id;
}, { place: WT, reason: 'texted_last', row: '13' });
fixture('D14 gone quiet after a human text', async (w) => {
  const id = await w.lead('quiet'); await w.text(id, 'outbound', w.at(-10 * DAY)); return id;
}, { place: NA, reason: 'gone_quiet', row: '14', headline: { kind: 'texted_silent' } });
fixture('D15 nothing planned (no events at all)', async (w) => w.lead('nothing'), { place: NA, reason: 'nothing_planned', row: '15' });

// Section 8 scenarios
fixture('S Rep schedules a drip, first text not sent', async (w) => {
  const id = await w.lead('s'); await w.drip(id, { next: w.at(2 * DAY), idx: 0 }); return id;
}, { place: WT, reason: 'in_drip', row: '10' });
fixture('S Drip running, no reply', async (w) => {
  const id = await w.lead('s'); const d = await w.drip(id, { idx: 2, next: w.at(3 * DAY) }); await w.dripText(id, d, 1, w.at(-2 * DAY)); return id;
}, { place: WT, reason: 'in_drip', row: '10' });
fixture('S Seller replies while drip running (drip paused by the reply)', async (w) => {
  const id = await w.lead('s'); const d = await w.drip(id, { status: 'paused', pause: 'inbound_reply', next: null, idx: 2 });
  await w.dripText(id, d, 1, w.at(-5 * HOUR)); await w.text(id, 'inbound', w.at(-3 * HOUR)); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S Seller replies while the drip is still active: reply overrides automation', async (w) => {
  const id = await w.lead('s'); await w.drip(id); await w.text(id, 'inbound', w.at(-3 * HOUR)); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S Rep texts back, send accepted', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.text(id, 'outbound', w.at(-2 * MIN)); return id;
}, { place: WT, reason: 'texted_last', row: '13', headline: { by: 'human' } });
fixture('S Rep approves a held AI draft and it is accepted', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR));
  await w.text(id, 'outbound', w.at(-2 * MIN), { meta: { generated_by: 'ai_responder_v1', approved_by_user_id: w.sam } }); return id;
}, { place: WT, reason: 'texted_last', row: '13', headline: { by: 'human' } });
fixture('S Auto-sent library template goes out', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR));
  await w.text(id, 'outbound', w.at(-2 * MIN), { meta: { reply_source: 'approved_template', generated_by: 'ai_responder_v1' } }); return id;
}, { place: WT, reason: 'texted_last', row: '13', headline: { by: 'ai' } });
fixture('S AI-written reply goes out', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR));
  await w.text(id, 'outbound', w.at(-2 * MIN), { meta: { generated_by: 'ai_responder_v1', inbound_message_id: randomUUID() } }); return id;
}, { place: WT, reason: 'texted_last', row: '13', headline: { by: 'ai' } });
fixture('S AI holds the reply for your OK: New reply with the AI-draft-waiting label', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.aiDraft(id, w.at(-2 * HOUR)); return id;
}, { place: NA, reason: 'new_reply', row: '5', labels: ['ai_draft_waiting'], brokenKinds: [] });
fixture('S Pending AI draft with the reply handled by a reached call: not Broken, label only', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.aiDraft(id, w.at(-2 * HOUR)); await w.attempt(id, w.at(-HOUR), 'reached'); return id;
}, { place: NA, reason: 'nothing_planned', row: '15', labels: ['ai_draft_waiting'], brokenKinds: [] });
fixture('S Pending AI draft alone is never Broken', async (w) => {
  const id = await w.lead('s'); await w.aiDraft(id, w.at(-2 * HOUR)); return id;
}, { place: NA, reason: 'nothing_planned', row: '15', labels: ['ai_draft_waiting'], brokenKinds: [] });
fixture('S AI dead letter is Broken · AI reply failed', async (w) => {
  const id = await w.lead('s'); await w.deadLetter(id, w.at(-2 * HOUR)); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'ai_reply_failed' } });
fixture('S Rep reply fails at send time: New reply stays, Broken label', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.text(id, 'outbound', w.at(-2 * HOUR), { status: 'failed' }); return id;
}, { place: NA, reason: 'new_reply', row: '5', labels: ['broken'], brokenKinds: ['text_not_sent'] });
fixture('S Reply Y arrives while rep is sending for X (stamped to X)', async (w) => {
  const id = await w.lead('s'); const x = await w.text(id, 'inbound', w.at(-3 * HOUR));
  await w.text(id, 'inbound', w.at(-2 * HOUR));
  await w.text(id, 'outbound', w.at(-HOUR), { meta: { inbound_message_id: x } }); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S Reply Y arrives before an unstamped text sent after it: handled by time order', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.text(id, 'inbound', w.at(-2 * HOUR));
  await w.text(id, 'outbound', w.at(-HOUR)); return id;
}, { place: WT, reason: 'texted_last', row: '13' });
fixture('S A text stamped to the newest inbound handles it', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); const y = await w.text(id, 'inbound', w.at(-2 * HOUR));
  await w.text(id, 'outbound', w.at(-HOUR), { meta: { inbound_message_id: y } }); return id;
}, { place: WT, reason: 'texted_last', row: '13' });
fixture('S A stamp pointing at another property is ignored (falls back to time order)', async (w) => {
  const id = await w.lead('s'); const otherLead = await w.lead('o'); const foreign = await w.text(otherLead, 'inbound', w.at(-9 * DAY));
  await w.text(id, 'inbound', w.at(-3 * HOUR));
  await w.text(id, 'outbound', w.at(-HOUR), { meta: { inbound_message_id: foreign } }); return id;
}, { place: WT, reason: 'texted_last', row: '13' });
fixture('S Note / open lead / call with no answer: New reply stays', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.note(id, w.at(-2 * HOUR)); await w.attempt(id, w.at(-HOUR), 'no_answer'); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S Rep leaves a voicemail after the reply (leaves New reply)', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.attempt(id, w.at(-HOUR), 'voicemail'); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S Rep leaves a voicemail, no-answer text went out: Texted last', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.attempt(id, w.at(-HOUR), 'voicemail'); await w.text(id, 'outbound', w.at(-50 * MIN)); return id;
}, { place: WT, reason: 'texted_last', row: '13' });
fixture('S Rep logs a reached call after the reply', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.attempt(id, w.at(-HOUR), 'reached'); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S wrong_number attempt alone does not clear New reply', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.attempt(id, w.at(-HOUR), 'wrong_number'); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S wrong_number clears through its user disposition event', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.attempt(id, w.at(-HOUR), 'wrong_number');
  await w.event(id, 'dispo_set', w.at(-50 * MIN)); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S A workflow event for logging an attempt does not clear New reply', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR));
  await w.event(id, 'my_leads_workflow', w.at(-HOUR), { payload: { operation: 'log_acquisition_attempt' } }); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S Workflow event (log offer) clears New reply', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR));
  await w.event(id, 'my_leads_workflow', w.at(-HOUR), { payload: { operation: 'log_acquisition_offer' } }); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S A system (non-user) disposition event does not clear New reply', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.event(id, 'dispo_set', w.at(-HOUR), { actor: 'system' }); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S Rep books a callback after reading the reply', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.event(id, 'appointment_booked', w.at(-HOUR)); await w.appt(id, w.at(DAY)); return id;
}, { place: WT, reason: 'callback_booked', row: '11' });
fixture('S A next step created by Norma (not a user event) does not clear New reply', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.event(id, 'task_created', w.at(-HOUR), { actor: 'ai' }); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S Rep starts a drip after reading the reply', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.drip(id, { by: w.sam, enrolledAt: w.at(-HOUR) }); return id;
}, { place: WT, reason: 'in_drip', row: '10' });
fixture('S An AI-routed drip enrollment does not clear New reply', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.drip(id, { enrolledAt: w.at(-HOUR) }); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S Callback due while drip active', async (w) => {
  const id = await w.lead('s'); await w.drip(id); await w.appt(id, w.at(-30 * MIN)); return id;
}, { place: NA, reason: 'due', row: '4' });
fixture('S Future callback later today', async (w) => {
  const id = await w.lead('s'); await w.appt(id, w.at(6 * HOUR)); return id;
}, { place: WT, reason: 'callback_booked', row: '11' });
fixture('S Drip completed, no reply', async (w) => {
  const id = await w.lead('s'); const d = await w.drip(id, { status: 'completed', next: null, idx: 3, completedAt: w.at(-13 * DAY) });
  await w.dripText(id, d, 3, w.at(-13 * DAY)); return id;
}, { place: NA, reason: 'gone_quiet', row: '14', headline: { kind: 'drip_finished' } });
fixture('S Drip completed but not on its final text: Nothing planned', async (w) => {
  const id = await w.lead('s'); const d = await w.drip(id, { status: 'completed', next: null, idx: 2, completedAt: w.at(-13 * DAY) });
  await w.dripText(id, d, 1, w.at(-13 * DAY)); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S Rep texted, silence 3 business days', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-6 * DAY)); return id;
}, { place: NA, reason: 'gone_quiet', row: '14' });
fixture('S Rep texted 3h ago', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-3 * HOUR)); return id;
}, { place: WT, reason: 'texted_last', row: '13' });
fixture('S Single scheduled campaign text, queued', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-DAY), { status: 'queued', campaign: true, scheduledFor: w.at(2 * DAY) }); return id;
}, { place: WT, reason: 'in_drip', row: '10' });
fixture('S Campaign text sent, no reply: Texted last', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-2 * HOUR), { campaign: true }); return id;
}, { place: WT, reason: 'texted_last', row: '13', headline: { by: 'campaign' } });
fixture('S Campaign text sent, 5 days of silence: Gone quiet', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-9 * DAY), { campaign: true }); return id;
}, { place: NA, reason: 'gone_quiet', row: '14' });
fixture('S Campaign row queued, scheduled_for 45 min ago, still queued', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-DAY), { status: 'queued', campaign: true, scheduledFor: w.at(-45 * MIN) }); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'scheduled_text_overdue' } });
fixture('S Drip completed, then rep booked a callback', async (w) => {
  const id = await w.lead('s'); const d = await w.drip(id, { status: 'completed', next: null, idx: 3, completedAt: w.at(-13 * DAY) });
  await w.dripText(id, d, 3, w.at(-13 * DAY)); await w.appt(id, w.at(2 * DAY)); return id;
}, { place: WT, reason: 'callback_booked', row: '11' });
fixture('S Drip completed, then rep sent a text 1 day ago', async (w) => {
  const id = await w.lead('s'); const d = await w.drip(id, { status: 'completed', next: null, idx: 3, completedAt: w.at(-13 * DAY) });
  await w.dripText(id, d, 3, w.at(-13 * DAY)); await w.text(id, 'outbound', w.at(-DAY)); return id;
}, { place: WT, reason: 'texted_last', row: '13' });
fixture('S Pending offer, chain task completed, no successor', async (w) => {
  const id = await w.lead('s', { stage: 'offer_sent' }); const chain = await w.appt(id, w.at(-2 * DAY), { status: 'completed' }); await w.offer(id, { followUpAt: w.at(-2 * DAY), chain }); return id;
}, { place: NA, reason: 'offer', row: '8', headline: { kind: 'follow_up_missing' } });
for (const [label, minutes, place, reason, row] of [
  ['follow-up 16 min away', 16, WT, 'offer_out', '12'], ['follow-up exactly 15 min away', 15, NA, 'offer', '8'],
  ['follow-up 1 min away', 1, NA, 'offer', '8'], ['follow-up due now', 0, NA, 'offer', '8'],
] as const) {
  fixture(`S Offer ${label}`, async (w) => {
    const id = await w.lead('s', { stage: 'offer_sent' }); const chain = await w.appt(id, w.at(minutes * MIN)); await w.offer(id, { followUpAt: w.at(minutes * MIN), chain }); return id;
  }, { place, reason, row });
}
fixture('S Legacy offer (no chain) follow-up in 5 days', async (w) => {
  const id = await w.lead('s', { stage: 'offer_sent' }); await w.offer(id, { followUpAt: w.at(5 * DAY) }); return id;
}, { place: WT, reason: 'offer_out', row: '12' });
fixture('S Norma call ended callback_requested (drip paused norma_call, callback task)', async (w) => {
  const id = await w.lead('s'); await w.drip(id, { status: 'paused', pause: 'norma_call', next: null });
  await w.appt(id, w.at(DAY), { sourceKey: `norma_call:${randomUUID()}` }); return id;
}, { place: WT, reason: 'callback_booked', row: '11', labels: ['norma_task'] });
fixture('S Norma call ended wrong_number (drip paused norma_call, custom task)', async (w) => {
  const id = await w.lead('s'); await w.drip(id, { status: 'paused', pause: 'norma_call', next: null });
  await w.appt(id, w.at(DAY), { type: 'custom', sourceKey: `norma_call:${randomUUID()}` }); return id;
}, { place: NA, reason: 'nothing_planned', row: '15', labels: ['norma_task'] });
fixture('S Norma request still open adds the Norma calling label only', async (w) => {
  const id = await w.lead('s'); await w.norma(id, 'dispatched', w.at(-5 * MIN)); return id;
}, { place: NA, reason: 'nothing_planned', row: '15', labels: ['norma_calling'] });
fixture('S Norma request needs_review is Broken', async (w) => {
  const id = await w.lead('s'); await w.norma(id, 'needs_review', w.at(-HOUR)); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'norma_needs_review' } });
fixture('S Enrollment paused:manual', async (w) => {
  const id = await w.lead('s'); await w.drip(id, { status: 'paused', pause: 'manual', next: null }); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S Enrollment paused:appointment_booked without a task', async (w) => {
  const id = await w.lead('s'); await w.drip(id, { status: 'paused', pause: 'appointment_booked', next: null }); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S Enrollment paused:person_took_over', async (w) => {
  const id = await w.lead('s'); await w.drip(id, { status: 'paused', pause: 'person_took_over', next: null }); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S Enrollment paused:call_in_progress for 5 minutes', async (w) => {
  const id = await w.lead('s'); await w.drip(id, { status: 'paused', pause: 'call_in_progress', updated: w.at(-5 * MIN) }); return id;
}, { place: WT, reason: 'in_drip', row: '10' });
fixture('S Enrollment paused:call_in_progress for 45 minutes is a stuck drip', async (w) => {
  const id = await w.lead('s'); await w.drip(id, { status: 'paused', pause: 'call_in_progress', updated: w.at(-45 * MIN) }); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'drip_stuck' } });
fixture('S Active drip whose next_run_at is 90 minutes late is Broken · drip is stuck', async (w) => {
  const id = await w.lead('s'); await w.drip(id, { next: w.at(-90 * MIN) }); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'drip_stuck' } });
fixture('S Active drip 30 minutes late is still healthy', async (w) => {
  const id = await w.lead('s'); await w.drip(id, { next: w.at(-30 * MIN) }); return id;
}, { place: WT, reason: 'in_drip', row: '10' });
fixture('S Active drip with an unknown step claim older than 15 minutes is stuck', async (w) => {
  const id = await w.lead('s'); const d = await w.drip(id); await w.staleClaim(d.enr, d.steps[0], w.at(-20 * MIN)); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'drip_stuck' } });
fixture('S Active drip with no next_run_at is not healthy', async (w) => {
  const id = await w.lead('s'); await w.drip(id, { next: null }); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
for (const reason of ['reconciliation_required', 'no_phone', 'template_missing', 'step_misconfigured', 'consent_unavailable', 'no_approved_sender']) {
  fixture(`S Drip paused ${reason} is Broken`, async (w) => {
    const id = await w.lead('s'); await w.drip(id, { status: 'paused', pause: reason, next: null }); return id;
  }, { place: NA, reason: 'broken', row: '6' });
}
// Friday / weekend / DST business-day cases (section 8: 3 business days in America/Chicago).
const FRI_4PM = '2026-10-16T21:00:00Z';          // Friday 4:00 PM CDT
const bdText = async (w: World, sentAt: string) => {
  const id = await w.lead('bd');
  await w.text(id, 'outbound', sentAt);
  return id;
};
fixture('S Friday 4 PM text, checked Monday 9 AM: Texted last', (w) => bdText(w, FRI_4PM),
  { place: WT, reason: 'texted_last', row: '13', at: () => iso('2026-10-19T14:00:00Z') });
fixture('S Friday 4 PM text, checked Wednesday 3:59 PM: still Texted last', (w) => bdText(w, FRI_4PM),
  { place: WT, reason: 'texted_last', row: '13', at: () => iso('2026-10-21T20:59:00Z') });
fixture('S Friday 4 PM text, checked Wednesday 4:00 PM: Gone quiet', (w) => bdText(w, FRI_4PM),
  { place: NA, reason: 'gone_quiet', row: '14', at: () => iso('2026-10-21T21:00:00Z') });
fixture('S Friday 4 PM text, checked Wednesday 5 PM: Gone quiet', (w) => bdText(w, FRI_4PM),
  { place: NA, reason: 'gone_quiet', row: '14', at: () => iso('2026-10-21T22:00:00Z') });
fixture('S Saturday text counts from Saturday (Wednesday same time)', (w) => bdText(w, '2026-10-17T15:00:00Z'),
  { place: WT, reason: 'texted_last', row: '13', at: () => iso('2026-10-21T14:59:00Z') });
fixture('S Thursday text expires Tuesday (weekend skipped)', (w) => bdText(w, '2026-10-15T21:00:00Z'),
  { place: NA, reason: 'gone_quiet', row: '14', at: () => iso('2026-10-20T21:00:00Z') });
fixture('S DST ends over the weekend: Friday 4 PM CDT text, Wednesday 3:30 PM CST is inside the window', (w) => bdText(w, '2026-10-30T21:00:00Z'),
  { place: WT, reason: 'texted_last', row: '13', at: () => iso('2026-11-04T21:30:00Z') });
fixture('S DST ends over the weekend: window closes Wednesday 4 PM CST (22:00Z), not 72 hours', (w) => bdText(w, '2026-10-30T21:00:00Z'),
  { place: NA, reason: 'gone_quiet', row: '14', at: () => iso('2026-11-04T22:00:00Z') });
fixture('S DST starts over the weekend: Friday 4 PM CST text, Wednesday 3:30 PM CDT is inside the window', (w) => bdText(w, '2027-03-12T22:00:00Z'),
  { place: WT, reason: 'texted_last', row: '13', at: () => iso('2027-03-17T20:30:00Z') });
fixture('S DST starts over the weekend: window closes Wednesday 4 PM CDT (21:00Z)', (w) => bdText(w, '2027-03-12T22:00:00Z'),
  { place: NA, reason: 'gone_quiet', row: '14', at: () => iso('2027-03-17T21:00:00Z') });
// 7 Chicago calendar days (rows 4/9), not a rolling 7x24 hours.
const chicagoWeek = (name: string, callbackAt: string, row: string, reason: string, now: string) =>
  fixture(name, async (w) => { const id = await w.lead('cw'); await w.appt(id, callbackAt); return id; },
    { place: NA, reason, row, at: () => iso(now) });
chicagoWeek('S Callback at the 7-day Chicago cutoff (no DST) is still Due', '2026-10-13T15:00:00Z', '4', 'due', '2026-10-20T15:00:00Z');
chicagoWeek('S Callback one minute past the 7-day Chicago cutoff is a missed callback', '2026-10-13T14:59:00Z', '9', 'due', '2026-10-20T15:00:00Z');
chicagoWeek('S Across the fall-back weekend the cutoff is 14:00Z, not 15:00Z: at the cutoff is Due', '2026-10-28T14:00:00Z', '4', 'due', '2026-11-04T15:00:00Z');
chicagoWeek('S Across the fall-back weekend: one minute before the cutoff is a missed callback', '2026-10-28T13:59:00Z', '9', 'due', '2026-11-04T15:00:00Z');
fixture('S Due callback and unanswered reply on the same lead: Due, reply still on the lead', async (w) => {
  const id = await w.lead('s'); await w.appt(id, w.at(-30 * MIN)); await w.text(id, 'inbound', w.at(-2 * HOUR)); return id;
}, { place: NA, reason: 'due', row: '4' });
fixture('S Offer logged with chained follow-up 5 days out is Offer out, not Callback booked', async (w) => {
  const id = await w.lead('s', { stage: 'offer_sent' }); const chain = await w.appt(id, w.at(5 * DAY)); await w.offer(id, { followUpAt: w.at(5 * DAY), chain }); return id;
}, { place: WT, reason: 'offer_out', row: '12' });
fixture('S Callback Thursday and offer follow-up Friday: Callback booked (earlier)', async (w) => {
  const id = await w.lead('s', { stage: 'offer_sent' }); const chain = await w.appt(id, w.at(3 * DAY)); await w.offer(id, { followUpAt: w.at(3 * DAY), chain });
  await w.appt(id, w.at(2 * DAY)); return id;
}, { place: WT, reason: 'callback_booked', row: '11' });
fixture('S Offer follow-up earlier than the callback: Offer out names the offer', async (w) => {
  const id = await w.lead('s', { stage: 'offer_sent' }); const chain = await w.appt(id, w.at(2 * DAY)); await w.offer(id, { followUpAt: w.at(2 * DAY), chain });
  await w.appt(id, w.at(3 * DAY)); return id;
}, { place: WT, reason: 'offer_out', row: '11' });
fixture('S Callback snoozed until tomorrow 9 AM is Callback booked at its effective time', async (w) => {
  const id = await w.lead('s'); await w.appt(id, w.at(-2 * HOUR), { status: 'snoozed', snoozedUntil: w.at(DAY) }); return id;
}, { place: WT, reason: 'callback_booked', row: '11' });
fixture('S Snoozed callback whose snooze passed 10 min ago, drip healthy: Due overrides the drip', async (w) => {
  const id = await w.lead('s'); await w.drip(id); await w.appt(id, w.at(-3 * HOUR), { status: 'snoozed', snoozedUntil: w.at(-10 * MIN) }); return id;
}, { place: NA, reason: 'due', row: '4' });
fixture('S Manual queued text plus a future callback: Nothing planned wins', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-HOUR), { status: 'queued' }); await w.appt(id, w.at(DAY)); return id;
}, { place: NA, reason: 'nothing_planned', row: '6a' });
fixture('S Manual queued text plus a healthy drip: Nothing planned wins', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-HOUR), { status: 'queued' }); await w.drip(id); return id;
}, { place: NA, reason: 'nothing_planned', row: '6a' });
fixture('S Accepted reply to X fails delivery, then Y arrives', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-5 * HOUR));
  const m = await w.text(id, 'outbound', w.at(-4 * HOUR), { status: 'failed' }); await w.ledger(id, 'delivery_failed', w.at(-3 * HOUR), { messageId: m });
  await w.text(id, 'inbound', w.at(-HOUR)); return id;
}, { place: NA, reason: 'new_reply', row: '5', labels: ['broken'] });
fixture('S Accepted reply to X fails delivery, no Y', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-5 * HOUR));
  const m = await w.text(id, 'outbound', w.at(-4 * HOUR), { status: 'failed' }); await w.ledger(id, 'delivery_failed', w.at(-3 * HOUR), { messageId: m }); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'text_not_delivered', action: 'resend' } });
fixture('S Failed text, then a replacement text accepted under a new key', async (w) => {
  const id = await w.lead('s');
  const m = await w.text(id, 'outbound', w.at(-4 * HOUR), { status: 'failed' }); await w.ledger(id, 'failed_not_dispatched', w.at(-4 * HOUR), { messageId: m });
  const r = await w.text(id, 'outbound', w.at(-3 * HOUR)); await w.ledger(id, 'accepted', w.at(-3 * HOUR), { messageId: r }); return id;
}, { place: WT, reason: 'texted_last', row: '13' });
fixture('S Failed text, then a no-answer call: still Broken', async (w) => {
  const id = await w.lead('s');
  const m = await w.text(id, 'outbound', w.at(-4 * HOUR), { status: 'failed' }); await w.ledger(id, 'failed_not_dispatched', w.at(-4 * HOUR), { messageId: m });
  await w.attempt(id, w.at(-HOUR), 'no_answer'); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'text_not_delivered' } });
fixture('S Failed text, then a user disposition: resolved', async (w) => {
  const id = await w.lead('s');
  const m = await w.text(id, 'outbound', w.at(-4 * HOUR), { status: 'failed' }); await w.ledger(id, 'failed_not_dispatched', w.at(-4 * HOUR), { messageId: m });
  await w.event(id, 'dispo_set', w.at(-HOUR)); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S Failed text, then a rep-started drip: resolved', async (w) => {
  const id = await w.lead('s');
  await w.ledger(id, 'failed_not_dispatched', w.at(-4 * HOUR));
  await w.drip(id, { by: w.sam, enrolledAt: w.at(-HOUR) }); return id;
}, { place: WT, reason: 'in_drip', row: '10' });
fixture('S Failed text, explicitly dismissed', async (w) => {
  const id = await w.lead('s');
  const l = await w.ledger(id, 'blocked', w.at(-4 * HOUR)); await w.event(id, 'rep_sms_failure_dismissed', w.at(-HOUR), { sourceId: l }); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S Ledger blocked is Broken · Review', async (w) => {
  const id = await w.lead('s'); await w.ledger(id, 'blocked', w.at(-HOUR)); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'text_blocked', action: 'review' } });
fixture('S Ledger unknown 20 min is Broken · status unknown (Check status, never Resend)', async (w) => {
  const id = await w.lead('s'); await w.ledger(id, 'unknown', w.at(-20 * MIN)); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'text_status_unknown', action: 'check_status' } });
fixture('S Ledger unknown dismissed (Check status can terminate it)', async (w) => {
  const id = await w.lead('s'); const l = await w.ledger(id, 'unknown', w.at(-20 * MIN)); await w.event(id, 'rep_sms_failure_dismissed', w.at(-MIN), { sourceId: l }); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S Obligation unknown dismissed', async (w) => {
  const id = await w.lead('s'); const o = await w.obligation(id, 'unknown', w.at(-20 * MIN)); await w.event(id, 'rep_sms_failure_dismissed', w.at(-MIN), { sourceId: o }); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
// Effective send time (sent_at), not created_at
fixture('S Campaign text created 9 days ago but sent 2 hours ago is Texted last, not Gone quiet', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-9 * DAY), { campaign: true, sentAt: w.at(-2 * HOUR) }); return id;
}, { place: WT, reason: 'texted_last', row: '13', headline: { by: 'campaign' } });
fixture('S Last outbound is ordered by send time: created earlier but sent later wins', async (w) => {
  const id = await w.lead('s');
  await w.text(id, 'outbound', w.at(-5 * HOUR), { campaign: true, sentAt: w.at(-HOUR) });
  await w.text(id, 'outbound', w.at(-2 * HOUR), { sentAt: w.at(-3 * HOUR) }); return id;
}, { place: WT, reason: 'texted_last', row: '13', headline: { by: 'campaign' } });
fixture('S Silence is measured from the send: sent 6 days ago, created 7 days ago', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-7 * DAY), { sentAt: w.at(-6 * DAY) }); return id;
}, { place: NA, reason: 'gone_quiet', row: '14', headline: { kind: 'texted_silent' } });
fixture('S A reply created before the inbound but sent after it handles the inbound', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR));
  await w.text(id, 'outbound', w.at(-4 * HOUR), { sentAt: w.at(-HOUR) }); return id;
}, { place: WT, reason: 'texted_last', row: '13' });
fixture('S A reply created after the inbound but sent before it does not handle it', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR));
  await w.text(id, 'outbound', w.at(-2 * HOUR), { sentAt: w.at(-4 * HOUR) }); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S Outbound with an unresolved reply-to stamp handles no reply but still counts as Texted last once the reply is handled', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR));
  await w.text(id, 'outbound', w.at(-HOUR), { meta: { inbound_stamp_unresolved: true } }); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S Unresolved-stamp text after a reached call: reply handled by the call, text is Texted last', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.attempt(id, w.at(-2 * HOUR), 'reached');
  await w.text(id, 'outbound', w.at(-HOUR), { meta: { inbound_stamp_unresolved: true } }); return id;
}, { place: WT, reason: 'texted_last', row: '13' });
// Durable acceptance: a later delivery failure never reopens the inbound it answered
fixture('S Ledger-accepted reply, newer inbound Y, then late delivery failure: Y stays unhandled', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-6 * HOUR));
  const m = await w.text(id, 'outbound', w.at(-5 * HOUR), { status: 'failed' }); await w.ledger(id, 'accepted', w.at(-5 * HOUR), { messageId: m });
  await w.text(id, 'inbound', w.at(-4 * HOUR));
  await w.raw("update public.rep_sms_delivery_ledger set state='delivery_failed', updated_at=$2 where message_id=$1", [m, w.at(-HOUR)]); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S Unstamped text accepted before Y then marked delivery_failed later does not handle Y or move the deadline', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-6 * HOUR));
  const m = await w.text(id, 'outbound', w.at(-5 * HOUR)); await w.ledger(id, 'accepted', w.at(-5 * HOUR), { messageId: m });
  await w.text(id, 'inbound', w.at(-4 * HOUR));
  await w.raw("update public.rep_sms_delivery_ledger set state='delivery_failed', updated_at=$2 where message_id=$1", [m, w.at(-MIN)]); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S Non-ledger reply with sent_at later flips to failed, no newer inbound: stays handled, Broken', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR));
  await w.text(id, 'outbound', w.at(-2 * HOUR), { status: 'failed', sentAt: w.at(-2 * HOUR) }); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'text_not_sent' } });
fixture('S Non-ledger reply with sent_at later flips to failed, then a newer inbound: New reply with Broken label', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-5 * HOUR));
  await w.text(id, 'outbound', w.at(-4 * HOUR), { status: 'failed', sentAt: w.at(-4 * HOUR) });
  await w.text(id, 'inbound', w.at(-HOUR)); return id;
}, { place: NA, reason: 'new_reply', row: '5', labels: ['broken'] });
fixture('S Ledger sending 5 min is not Broken yet', async (w) => {
  const id = await w.lead('s'); await w.ledger(id, 'sending', w.at(-5 * MIN)); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S Ledger sending 20 min is Broken · status unknown', async (w) => {
  const id = await w.lead('s'); await w.ledger(id, 'sending', w.at(-20 * MIN)); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'text_status_unknown' } });
fixture('S Ledger unknown reconciled to delivered: Texted last', async (w) => {
  const id = await w.lead('s'); const m = await w.text(id, 'outbound', w.at(-30 * MIN)); await w.ledger(id, 'delivered', w.at(-5 * MIN), { messageId: m }); return id;
}, { place: WT, reason: 'texted_last', row: '13' });
fixture('S Manual send with no ledger receipt stored failed + provider_unknown: Check status', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-HOUR), { status: 'failed', meta: { providerOutcome: 'provider_unknown' } }); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'text_status_unknown', action: 'check_status' } });
fixture('S Same, reconciled to delivered: Texted last', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-HOUR), { status: 'delivered', meta: { providerOutcome: 'provider_unknown' } }); return id;
}, { place: WT, reason: 'texted_last', row: '13' });
fixture('S Same, reconciled to a definitive failure: Resend', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-HOUR), { status: 'failed' }); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'text_not_sent', action: 'resend' } });
fixture('S Human text pending for 20 minutes: Check status', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-20 * MIN), { status: 'pending' }); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'text_status_unknown' } });
fixture('S A failed human text older than 7 days no longer shows', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-8 * DAY), { status: 'failed' }); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S Obligation required is Broken · Send text', async (w) => {
  const id = await w.lead('s'); await w.obligation(id, 'required', w.at(-HOUR)); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'followup_text_not_sent', action: 'send_text' } });
fixture('S Obligation delivery_failed is Broken · Resend', async (w) => {
  const id = await w.lead('s'); await w.obligation(id, 'delivery_failed', w.at(-HOUR)); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'followup_text_not_delivered', action: 'resend' } });
fixture('S Obligation claimed past its lease is Check status', async (w) => {
  const id = await w.lead('s'); await w.obligation(id, 'claimed', w.at(-HOUR), { lease: w.at(-30 * MIN) }); return id;
}, { place: NA, reason: 'broken', row: '6', headline: { kind: 'followup_text_status_unknown', action: 'check_status' } });
fixture('S Obligation claimed inside its lease is not Broken', async (w) => {
  const id = await w.lead('s'); await w.obligation(id, 'claimed', w.at(-5 * MIN), { lease: w.at(5 * MIN) }); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S Obligation accepted is fine', async (w) => {
  const id = await w.lead('s'); await w.obligation(id, 'accepted', w.at(-HOUR)); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S Nurture drip, next text in 60 days', async (w) => {
  const id = await w.lead('s'); await w.drip(id, { next: w.at(60 * DAY) }); return id;
}, { place: WT, reason: 'in_drip', row: '10' });
fixture('S Ready for offer, none logged', async (w) => {
  const id = await w.lead('s', { stage: 'needs_offer' }); return id;
}, { place: NA, reason: 'offer', row: '7' });
fixture('S Offer follow-up date arrives', async (w) => {
  const id = await w.lead('s', { stage: 'offer_sent' }); const chain = await w.appt(id, w.at(-5 * MIN)); await w.offer(id, { followUpAt: w.at(-5 * MIN), chain }); return id;
}, { place: NA, reason: 'offer', row: '8', headline: { kind: 'follow_up_due' } });
fixture('S No phone: placed by its reason, label shown', async (w) => w.lead('s', { phone: false }), { place: NA, reason: 'nothing_planned', row: '15', labels: ['no_phone'] });
fixture('S Contact DNC: placed by its reason, label shown', async (w) => w.lead('s', { dnc: true }), { place: NA, reason: 'nothing_planned', row: '15', labels: ['do_not_contact'] });
fixture('S Under contract, nothing due', async (w) => w.lead('s', { stage: 'under_contract' }), { place: NE, reason: 'under_contract', row: '1' });
fixture('S Rep text, then a later inbound after it, reply already handled by an earlier reply: newest inbound decides', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-6 * HOUR)); await w.text(id, 'outbound', w.at(-5 * HOUR)); await w.text(id, 'inbound', w.at(-HOUR)); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S Texted last with a drip text as the last outbound is not Texted last', async (w) => {
  const id = await w.lead('s'); const d = await w.drip(id, { status: 'paused', pause: 'manual', next: null, idx: 1 }); await w.dripText(id, d, 0, w.at(-2 * HOUR)); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S Norma pre-call text alone is neither Texted last nor a reply', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-HOUR), { meta: { generated_by: 'norma_precall' } }); return id;
}, { place: NA, reason: 'nothing_planned', row: '15' });
fixture('S Norma pre-call text does not answer an inbound', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.text(id, 'outbound', w.at(-HOUR), { meta: { generated_by: 'norma_precall' } }); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S A drip text does not answer an inbound', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR));
  const d = await w.drip(id, { status: 'paused', pause: 'manual', next: null }); await w.dripText(id, d, 0, w.at(-HOUR)); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S A campaign text does not answer an inbound', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.text(id, 'outbound', w.at(-HOUR), { campaign: true }); return id;
}, { place: NA, reason: 'new_reply', row: '5' });
fixture('S A queued or failed text does not answer an inbound', async (w) => {
  const id = await w.lead('s'); await w.text(id, 'inbound', w.at(-3 * HOUR)); await w.text(id, 'outbound', w.at(-HOUR), { status: 'queued' }); return id;
}, { place: NA, reason: 'new_reply', row: '5' });

// ---- invariants -----------------------------------------------------------------------------------------
async function mixedWorld(w: World) {
  const ids: Record<string, string> = {};
  ids.fresh = await w.lead('fresh', { fresh: true });
  ids.pin = await w.lead('pin'); await w.pin(ids.pin, w.at(-HOUR), w.at(10 * HOUR));
  ids.due = await w.lead('due'); await w.appt(ids.due, w.at(5 * MIN));
  ids.missed = await w.lead('missed'); await w.appt(ids.missed, w.at(-10 * DAY));
  ids.reply = await w.lead('reply'); await w.text(ids.reply, 'inbound', w.at(-2 * HOUR));
  ids.replyDrip = await w.lead('replyDrip'); await w.drip(ids.replyDrip); await w.text(ids.replyDrip, 'inbound', w.at(-HOUR));
  ids.broken = await w.lead('broken'); await w.ledger(ids.broken, 'blocked', w.at(-HOUR));
  ids.queued = await w.lead('queued'); await w.text(ids.queued, 'outbound', w.at(-HOUR), { status: 'queued' });
  ids.needsOffer = await w.lead('needsOffer', { stage: 'needs_offer' });
  ids.offerDue = await w.lead('offerDue', { stage: 'offer_sent' }); await w.offer(ids.offerDue, { followUpAt: w.at(-HOUR) });
  ids.offerOut = await w.lead('offerOut', { stage: 'offer_sent' }); await w.offer(ids.offerOut, { followUpAt: w.at(4 * DAY) });
  ids.drip = await w.lead('drip'); await w.drip(ids.drip, { next: w.at(2 * DAY) });
  ids.callback = await w.lead('callback'); await w.appt(ids.callback, w.at(DAY));
  ids.texted = await w.lead('texted'); await w.text(ids.texted, 'outbound', w.at(-HOUR));
  ids.quiet = await w.lead('quiet'); await w.text(ids.quiet, 'outbound', w.at(-9 * DAY));
  ids.nothing = await w.lead('nothing');
  ids.contract = await w.lead('contract', { stage: 'under_contract' });
  ids.contacted = await w.lead('contacted', { stage: 'contacted' });
  ids.campaign = await w.lead('campaign'); await w.text(ids.campaign, 'outbound', w.at(-DAY), { status: 'queued', campaign: true, scheduledFor: w.at(DAY) });
  return ids;
}

it('every queue lead matches exactly one decision row', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const ids = await mixedWorld(w);
    const rows = (await db.query('select property_id, row_no, count(*) over (partition by property_id) as n from public.my_leads_work_classified($1,$2,$3)', [w.org, w.sam, w.pAt.toISOString()])).rows;
    expect(rows).toHaveLength(Object.keys(ids).length);
    for (const r of rows) { expect(r.n).toBe('1'); expect(['1', '2', '3', '4', '5', '6', '6a', '7', '8', '9', '10', '11', '12', '13', '14', '15']).toContain(r.row_no); }
    const byName = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
    const seen = new Set(rows.map((r) => byName[r.property_id]));
    expect([...seen].sort()).toEqual(Object.keys(ids).sort());
  });
});

it('chip counts sum to the tab total, tab counts partition the queue, and every Waiting row carries a concrete timer', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const ids = await mixedWorld(w);
    const all = await w.page(w.sam, { tab: 'all', size: 50 });
    expect(all.total).toBe(Object.keys(ids).length);
    const neither = (all.rows as Json[]).filter((r) => r.place === 'neither').length;
    expect(all.tabCounts.needs_attention + all.tabCounts.waiting + neither).toBe(all.tabCounts.all);
    for (const tab of ['needs_attention', 'waiting', 'all']) {
      const r = await w.page(w.sam, { tab, size: 50 });
      const sum = Object.values(r.chipCounts as Record<string, number>).reduce((a, b) => a + Number(b), 0);
      expect(sum, tab).toBe(r.total);
      expect(r.tabCounts[tab]).toBe(r.total);
      expect(r.rows).toHaveLength(r.total);
    }
    // The three tabs are disjoint and cover the queue (Neither only in All).
    const na = await w.page(w.sam, { tab: 'needs_attention', size: 50 });
    const wt = await w.page(w.sam, { tab: 'waiting', size: 50 });
    const naIds = new Set<string>(na.ids); const wtIds = new Set<string>(wt.ids);
    for (const id of wtIds) expect(naIds.has(id)).toBe(false);
    expect(na.total + wt.total).toBe(all.total - 1);   // the under-contract lead
    // Stage counts follow the tab and chip.
    expect(Object.values(na.stageCounts as Record<string, number>).reduce((a, b) => a + Number(b), 0)).toBe(na.total);
    // Chip filter returns exactly that chip's rows.
    const chip = await w.page(w.sam, { tab: 'needs_attention', chip: 'broken', size: 50 });
    expect(chip.total).toBe(na.chipCounts.broken);
    expect(chip.rows.every((r: Json) => r.reason === 'broken')).toBe(true);
    // Every Waiting row has a timer.
    for (const row of wt.rows as Json[]) {
      const h = row.headline;
      const timer = row.reason === 'in_drip' ? (h.nextRunAt ?? h.scheduledAt ?? h.resumeBy)
        : row.reason === 'texted_last' ? h.until : h.at;
      expect(timer, `${row.reason} ${JSON.stringify(h)}`).toBeTruthy();
    }
  });
});

it('sorts Needs attention by reason rank then the within-reason key; Waiting by next event time', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const ids = await mixedWorld(w);
    const na = await w.page(w.sam, { tab: 'needs_attention', size: 50 });
    const rank = ['new_lead', 'call_today', 'due', 'new_reply', 'broken', 'offer', 'gone_quiet', 'nothing_planned'];
    const reasons = (na.rows as Json[]).map((r) => rank.indexOf(r.reason));
    expect(reasons).toEqual([...reasons].sort((a, b) => a - b));
    expect(na.ids[0]).toBe(ids.fresh);
    const dueIds = (na.rows as Json[]).filter((r) => r.reason === 'due').map((r) => r.propertyId);
    expect(dueIds).toEqual([ids.missed, ids.due]);   // earliest effective time first
    const wt = await w.page(w.sam, { tab: 'waiting', size: 50 });
    const times = (wt.rows as Json[]).map((r) => new Date(r.reason === 'texted_last' ? r.headline.until : r.reason === 'in_drip' ? (r.headline.nextRunAt ?? r.headline.scheduledAt) : r.headline.at).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

it('rows, counts, revision and next_change_at come from one statement and paginate consistently', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    await mixedWorld(w);
    const full = await w.page(w.sam, { tab: 'all', size: 50 });
    const pages: Json[] = [];
    for (let p = 1; p <= 4; p += 1) pages.push(await w.page(w.sam, { tab: 'all', size: 5, page: p }));
    expect(pages.flatMap((p) => p.ids)).toEqual(full.ids);
    expect(new Set(pages.map((p) => p.revision)).size).toBe(1);
    expect(pages.every((p) => p.total === full.total && p.tabCounts.all === full.total)).toBe(true);
    // Clamps to the last page when the requested page is past the end.
    const past = await w.page(w.sam, { tab: 'all', size: 5, page: 99 });
    expect(past.page).toBe(Math.ceil(full.total / 5));
    expect(past.ids).toEqual(pages[3].ids);
    const empty = await w.page(w.sam, { tab: 'waiting', size: 5, stage: 'under_contract', page: 3 });
    expect(empty).toMatchObject({ total: 0, page: 1, ids: [] });
  });
});

it('revision changes when membership or order changes and not otherwise', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const a = await w.lead('a'); await w.text(a, 'inbound', w.at(-3 * HOUR));
    const b = await w.lead('b'); await w.text(b, 'inbound', w.at(-2 * HOUR));
    const r1 = await w.page(w.sam);
    expect((await w.page(w.sam)).revision).toBe(r1.revision);
    expect(r1.ids).toEqual([b, a]);                    // newest reply first
    await w.text(a, 'inbound', w.at(-HOUR));           // a becomes newest: order change
    const r2 = await w.page(w.sam);
    expect(r2.ids).toEqual([a, b]);
    expect(r2.revision).not.toBe(r1.revision);
    await w.text(a, 'outbound', w.at(-30 * MIN));      // a leaves the tab: membership change
    const r3 = await w.page(w.sam);
    expect(r3.ids).toEqual([b]);
    expect(r3.revision).not.toBe(r2.revision);
  });
});

it('a callback crossing the due boundary with no writes is caught by next_change_at', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const id = await w.lead('cb'); await w.appt(id, w.at(HOUR));
    const first = await w.page(w.sam, { tab: 'waiting' });
    expect(first.ids).toEqual([id]);
    expect(new Date(first.nextChangeAt).toISOString()).toBe(w.at(HOUR - 15 * MIN));
    const later = new Date(new Date(first.nextChangeAt).getTime());
    const after = await w.page(w.sam, { tab: 'needs_attention', when: later });
    expect(after.ids).toEqual([id]);
    expect(after.rows[0].reason).toBe('due');
    const before = await w.page(w.sam, { tab: 'needs_attention', when: new Date(later.getTime() - 1000) });
    expect(before.ids).toEqual([]);
  });
});

it('a text crossing 3 business days is caught by next_change_at', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const id = await w.lead('bd'); await w.text(id, 'outbound', FRI_4PM);
    const at = iso('2026-10-19T14:00:00Z');
    const waiting = await w.page(w.sam, { tab: 'waiting', when: at });
    expect(waiting.ids).toEqual([id]);
    expect(new Date(waiting.nextChangeAt).toISOString()).toBe('2026-10-21T21:00:00.000Z');
    const quiet = await w.page(w.sam, { tab: 'needs_attention', when: new Date(waiting.nextChangeAt) });
    expect(quiet.rows[0]).toMatchObject({ reason: 'gone_quiet' });
  });
});

it('next_change_at covers drip late-window, call-in-progress, ledger and campaign timers', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const a = await w.lead('a'); await w.drip(a, { next: w.at(30 * MIN) });
    expect(new Date((await w.page(w.sam, { tab: 'all' })).nextChangeAt).toISOString()).toBe(plus1ms(w.at(90 * MIN)));
    const b = await w.lead('b'); await w.drip(b, { status: 'paused', pause: 'call_in_progress', updated: w.at(-10 * MIN) });
    expect(new Date((await w.page(w.sam, { tab: 'all' })).nextChangeAt).toISOString()).toBe(plus1ms(w.at(20 * MIN)));
    const c = await w.lead('c'); await w.ledger(c, 'sending', w.at(-5 * MIN));
    expect(new Date((await w.page(w.sam, { tab: 'all' })).nextChangeAt).toISOString()).toBe(plus1ms(w.at(10 * MIN)));
  });
});

it('exposes the pending AI draft id for the Fix action', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const id = await w.lead('d'); await w.text(id, 'inbound', w.at(-HOUR)); await w.aiDraft(id, w.at(-30 * MIN));
    const draft = (await db.query('select id from public.ai_reply_drafts where property_id=$1', [id])).rows[0].id;
    const r = await w.one(id);
    expect(r.facts).toMatchObject({ reason: 'new_reply', aiDraftId: draft });
    expect(r.labels).toContain('ai_draft_waiting');
  });
});

it('next_change_at includes the instant a Call today pin lapses', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const id = await w.lead('pin'); await w.pin(id, w.at(-HOUR), w.at(3 * HOUR));
    const r = await w.page(w.sam, { tab: 'needs_attention' });
    expect(r.rows[0].reason).toBe('call_today');
    expect(new Date(r.nextChangeAt).toISOString()).toBe(w.at(3 * HOUR));
    const lapsed = await w.page(w.sam, { tab: 'needs_attention', when: new Date(r.nextChangeAt) });
    expect(lapsed.rows[0].reason).toBe('nothing_planned');
  });
});

it('a fresh unknown step claim (not yet 15 minutes old) schedules the stuck boundary', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const id = await w.lead('s'); const d = await w.drip(id, { next: w.at(HOUR) }); await w.staleClaim(d.enr, d.steps[0], w.at(-5 * MIN));
    const r = await w.page(w.sam, { tab: 'waiting' });
    expect(r.ids).toEqual([id]);
    expect(new Date(r.nextChangeAt).toISOString()).toBe(plus1ms(w.at(10 * MIN)));
    // the reported boundary is the first instant at which the strict 'older than 15 min' rule is true
    const later = await w.page(w.sam, { tab: 'needs_attention', when: new Date(r.nextChangeAt) });
    expect(later.rows[0]).toMatchObject({ reason: 'broken' });
  });
});

it('an expiring claimed obligation: the reported boundary is the first instant it is Broken', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const id = await w.lead('s'); await w.obligation(id, 'claimed', w.at(-5 * MIN), { lease: w.at(10 * MIN) });
    const r = await w.page(w.sam, { tab: 'all' });
    expect(r.rows[0].reason).toBe('nothing_planned');
    expect(new Date(r.nextChangeAt).toISOString()).toBe(plus1ms(w.at(10 * MIN)));
    const later = await w.page(w.sam, { tab: 'needs_attention', when: new Date(r.nextChangeAt) });
    expect(later.rows[0]).toMatchObject({ reason: 'broken', headline: { kind: 'followup_text_status_unknown' } });
  });
});

it('a callback crossing 7 Chicago days with an unanswered reply present: next_change_at lands where the reply takes over', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const now = iso('2026-10-20T15:00:00Z');
    const id = await w.lead('s'); await w.appt(id, '2026-10-13T16:00:00Z'); await w.text(id, 'inbound', '2026-10-19T12:00:00Z');
    const before = await w.page(w.sam, { tab: 'needs_attention', when: now });
    expect(before.rows[0]).toMatchObject({ reason: 'due', rowNo: '4' });
    expect(new Date(before.nextChangeAt).toISOString()).toBe('2026-10-20T16:00:00.001Z');
    const after = await w.page(w.sam, { tab: 'needs_attention', when: new Date(before.nextChangeAt) });
    expect(after.rows[0]).toMatchObject({ reason: 'new_reply', rowNo: '5' });
  });
});

it('a 7-day-old pending text leaves Broken and the badge at the returned boundary', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const id = await w.lead('s'); await w.text(id, 'outbound', w.at(-(7 * DAY - 2 * HOUR)), { status: 'pending' });
    const r = await w.page(w.sam, { tab: 'needs_attention' });
    expect(r.rows[0]).toMatchObject({ reason: 'broken', headline: { kind: 'text_status_unknown' } });
    expect(await w.badge(w.sam)).toBe(1);
    expect(new Date(r.nextChangeAt).toISOString()).toBe(w.at(2 * HOUR));
    const later = new Date(r.nextChangeAt);
    expect((await w.page(w.sam, { tab: 'needs_attention', when: later })).rows[0]).toMatchObject({ reason: 'nothing_planned' });
    expect(await w.badge(w.sam, later)).toBe(0);
  });
});

it('search is bounded, stacks with chips and stage, and matches name, address and phone', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const a = await w.lead('Alpha'); await w.text(a, 'inbound', w.at(-HOUR));
    const b = await w.lead('Bravo', { stage: 'contacted' }); await w.text(b, 'inbound', w.at(-2 * HOUR));
    expect((await w.page(w.sam, { search: 'alpha' })).ids).toEqual([a]);
    expect((await w.page(w.sam, { search: 'Bravo Main' })).ids).toEqual([b]);
    expect((await w.page(w.sam, { stage: 'contacted' })).ids).toEqual([b]);
    expect((await w.page(w.sam, { stage: 'contacted', search: 'alpha' })).ids).toEqual([]);
    expect((await w.page(w.sam, { chip: 'new_reply', search: 'bravo' })).ids).toEqual([b]);
    expect((await w.page(w.sam, { chip: 'broken' })).ids).toEqual([]);
    const phone = (await db.query('select phone_1 from public.contacts where first_name=$1', ['Alpha'])).rows[0].phone_1 as string;
    expect((await w.page(w.sam, { search: phone.slice(-6) })).ids).toEqual([a]);
    // % and _ are literal, not wildcards.
    expect((await w.page(w.sam, { search: '%' })).ids).toEqual([]);
    await w.expectError(() => w.page(w.sam, { search: 'x'.repeat(201) }), /INVALID_INPUT/);
    await w.page(w.sam, { search: 'x'.repeat(200) });
  });
});

it('rejects out-of-range sizes, pages, tabs, chips and stages', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    for (const bad of [{ size: 0 }, { size: 51 }, { page: 0 }, { tab: 'everything' }, { chip: 'sparkly' }, { stage: 'nope' }]) {
      await w.expectError(() => w.page(w.sam, bad as never), /INVALID_INPUT/);
    }
    await w.page(w.sam, { size: 1 }); await w.page(w.sam, { size: 50 });
    await w.expectError(() => w.as('authenticated', w.sam, async () => db.query('select public.fn_my_leads_work_facts($1,$2,$3)', [w.org, w.sam, Array.from({ length: 51 }, () => randomUUID())])), /INVALID_INPUT/);
  });
});

it('scope: owner may read any rep, a rep only themselves; cross-org, outsiders and anon are refused', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const mine = await w.lead('mine'); await w.text(mine, 'inbound', w.at(-HOUR));
    const theirs = await w.lead('theirs', { assignee: w.other }); await w.text(theirs, 'inbound', w.at(-HOUR));
    expect((await w.page(w.sam)).ids).toEqual([mine]);
    expect((await w.page(w.other, { member: w.other })).ids).toEqual([theirs]);
    expect((await w.page(w.jarrad, { member: w.sam })).ids).toEqual([mine]);
    expect((await w.facts(w.jarrad, [mine], w.sam)).rows).toHaveLength(1);
    await w.expectError(() => w.page(w.sam, { member: w.other }), /FORBIDDEN/);
    await w.expectError(() => w.facts(w.sam, [theirs], w.other), /FORBIDDEN/);
    await w.expectError(() => w.page(w.other, { member: w.sam }), /FORBIDDEN/);
    await w.expectError(() => w.page(w.outsider, { member: w.sam }), /FORBIDDEN/);
    await w.expectError(() => w.page(w.outsider, { member: w.outsider }), /FORBIDDEN|NOT_FOUND/);
    await w.expectError(() => w.page(w.sam, { orgId: w.org2 }), /FORBIDDEN/);
    // Another rep's lead id never leaks through the facts function.
    const f = await w.facts(w.sam, [theirs]);
    expect(f.rows).toEqual([]);
    expect(f.missing).toEqual([theirs]);
    await w.expectError(() => w.as('anon', null, async () => db.query('select public.fn_my_leads_work_page($1,$2,$3,$4,$5,$6,$7,$8,$9)', [w.org, w.sam, 'all', null, null, null, 1, 25, null])), /permission denied|FORBIDDEN/);
    await w.expectError(() => w.as('anon', null, async () => db.query('select public.fn_my_leads_badge_v2($1)', [null])), /permission denied/);
    await w.expectError(() => w.as('authenticated', w.sam, async () => db.query('select * from public.my_leads_work_classified($1,$2,$3)', [w.org, w.sam, w.pAt.toISOString()])), /permission denied/);
  });
});

it('work_facts returns current facts for given ids and lists ids that left the queue', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const a = await w.lead('a'); await w.text(a, 'inbound', w.at(-HOUR));
    const gone = randomUUID();
    const f = await w.facts(w.sam, [a, gone]);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({ propertyId: a, reason: 'new_reply', place: 'your_move', latestInbound: { handled: false, kind: 'text' } });
    expect(f.missing).toEqual([gone]);
    await w.text(a, 'outbound', w.at(-MIN));
    expect((await w.facts(w.sam, [a])).rows[0]).toMatchObject({ reason: 'texted_last', place: 'their_move' });
  });
});

it('row facts carry stage, drip, next step, last touch, attempts, assignment, inbound and contact flags', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const id = await w.lead('rich', { stage: 'contacted' });
    const d = await w.drip(id, { idx: 1, next: w.at(2 * DAY) }); await w.dripText(id, d, 0, w.at(-DAY));
    await w.appt(id, w.at(DAY));
    const r = (await w.page(w.sam, { tab: 'all' })).rows[0];
    expect(r).toMatchObject({ propertyId: id, stage: 'contacted', place: 'their_move', reason: 'in_drip', hasPhone: true, contactDnc: false, attemptsCount: 1 });
    expect(r.drip).toMatchObject({ status: 'active', name: expect.stringContaining('Warm check-in'), step: 2, stepsTotal: 4, healthy: true });
    expect(new Date(r.drip.lastSentAt).toISOString()).toBe(w.at(-DAY));
    expect(new Date(r.nextStep.callbackAt).toISOString()).toBe(w.at(DAY));
    expect(r.lastTouchAt).toBeTruthy();
    expect(r.assignedAt).toBeTruthy();
    expect(r.row).toMatchObject({ address: 'rich Main', propertyId: id });
  });
});

it('badge counts distinct leads in Due, New reply or Broken for the viewer only', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const both = await w.lead('both'); await w.appt(both, w.at(-HOUR)); await w.text(both, 'inbound', w.at(-2 * HOUR));
    const reply = await w.lead('reply'); await w.text(reply, 'inbound', w.at(-HOUR));
    const broken = await w.lead('broken'); await w.ledger(broken, 'blocked', w.at(-HOUR));
    const missed = await w.lead('missed'); await w.appt(missed, w.at(-9 * DAY));
    await w.lead('quiet'); const t = await w.lead('texted'); await w.text(t, 'outbound', w.at(-HOUR));
    const o = await w.lead('o', { assignee: w.other }); await w.text(o, 'inbound', w.at(-HOUR));
    expect(await w.badge(w.sam)).toBe(4);
    expect(await w.badge(w.other)).toBe(1);
    expect(await w.badge(w.jarrad)).toBe(0);   // the owner's own queue, not the reps'
    expect(await w.badge(w.outsider)).toBe(0);
  });
});

it('classifies a 400-lead queue within the timing bound, rows and counts from one call', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    for (let i = 0; i < 400; i += 1) {
      const id = await w.lead(`bulk${i}`, { stage: i % 9 === 0 ? 'contacted' : i % 11 === 0 ? 'needs_offer' : undefined });
      if (i % 4 === 0) await w.text(id, 'inbound', w.at(-(i % 40 + 1) * HOUR));
      else if (i % 4 === 1) await w.text(id, 'outbound', w.at(-(i % 50 + 1) * HOUR));
      else if (i % 4 === 2) await w.drip(id, { next: w.at((i % 30 + 1) * HOUR) });
      if (i % 7 === 0) await w.appt(id, w.at((i % 5 - 2) * DAY));
      if (i % 13 === 0) { const m = await w.text(id, 'outbound', w.at(-2 * HOUR), { status: 'failed' }); await w.ledger(id, 'delivery_failed', w.at(-HOUR), { messageId: m }); }
      for (let k = 0; k < 4; k += 1) await w.text(id, k % 2 ? 'inbound' : 'outbound', w.at(-(20 + k) * DAY));   // older message history
    }
    await db.query('analyze');
    const t0 = Date.now();
    const r = await w.page(w.sam, { tab: 'all', size: 50 });
    const elapsed = Date.now() - t0;
    expect(r.total).toBe(400);
    expect(r.ids).toHaveLength(50);
    expect(Object.values(r.chipCounts as Record<string, number>).reduce((a, b) => a + Number(b), 0)).toBe(400);
    console.log(`work_page over 400 leads: ${elapsed} ms`);
    expect(elapsed).toBeLessThan(1500);
    const b0 = Date.now();
    await w.badge(w.sam);
    expect(Date.now() - b0).toBeLessThan(1500);
  });
}, 120_000);

it('is read-only: no table is written', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    await mixedWorld(w);
    const before = (await db.query("select sum(n_tup_ins + n_tup_upd + n_tup_del)::bigint as n from pg_stat_xact_all_tables where schemaname='public'")).rows[0].n;
    await w.page(w.sam, { tab: 'all' }); await w.badge(w.sam); await w.facts(w.sam, [randomUUID()]);
    const after = (await db.query("select sum(n_tup_ins + n_tup_upd + n_tup_del)::bigint as n from pg_stat_xact_all_tables where schemaname='public'")).rows[0].n;
    expect(after).toBe(before);
  });
});

it('business-day helper: Friday, weekend, DST', async () => {
  await withDb(async (db) => {
    const bd = async (ts: string, n = 3) => new Date((await db.query('select public.my_leads_add_business_days($1,$2) as r', [ts, n])).rows[0].r).toISOString();
    expect(await bd(FRI_4PM)).toBe('2026-10-21T21:00:00.000Z');
    expect(await bd('2026-10-12T15:00:00Z')).toBe('2026-10-15T15:00:00.000Z');          // Monday -> Thursday
    expect(await bd('2026-10-17T15:00:00Z')).toBe('2026-10-21T15:00:00.000Z');          // Saturday -> Wednesday
    expect(await bd('2026-10-30T21:00:00Z')).toBe('2026-11-04T22:00:00.000Z');          // across fall-back
    expect(await bd('2027-03-12T22:00:00Z')).toBe('2027-03-17T21:00:00.000Z');          // across spring-forward
    expect(await bd(FRI_4PM, 0)).toBe(FRI_4PM.replace('Z', '.000Z'));
  });
});
