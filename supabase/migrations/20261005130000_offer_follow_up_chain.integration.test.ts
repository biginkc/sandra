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
  './20261005121200_next_step_mode_aware_lifecycle.sql',
  './20261005121500_next_step_relabel_functions.sql',
].map(strip);
const offerMigration = strip('./20261005130000_offer_follow_up_chain.sql');
const offerRollback = strip('../rollbacks/20261005130000_offer_follow_up_chain.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Role = 'authenticated' | 'anon' | 'service_role';

async function withDb(files: string[], fn: (db: Client) => Promise<void>) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    for (const file of files) await db.query(file);
    await fn(db);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

async function world(db: Client) {
  const org = randomUUID(), jarrad = randomUUID(), sam = randomUUID();
  for (const id of [jarrad, sam]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1,'Offer follow-up')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [jarrad, org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [sam, org]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled,needs_sequence_owner_id) values ($1,true,$2)', [org, jarrad]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [jarrad]);
  for (const id of [jarrad, sam]) {
    await db.query("select set_config('my_leads.designation_update',$1,true)", [`${jarrad}:${org}:${id}`]);
    await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [id, org]);
  }
  await db.query("select set_config('my_leads.designation_update','',true)");
  await db.query("select set_config('request.jwt.claim.sub','',true)");
  const prop = async (key: string, assignee: string | null = sam) => {
    const id = randomUUID();
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,$3,'MO','new_lead',$4)", [id, org, `${key} Main`, assignee]);
    return id;
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
  const episode = async (property: string) => (await db.query('select id from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null', [property])).rows[0].id as string;
  const logOffer = async (property: string, over: { followUpAt?: string; sentAt?: string; key?: string; by?: string; version?: number; status?: string } = {}) => {
    const key = over.key ?? randomUUID();
    const ep = await episode(property);
    const r = await as('authenticated', over.by ?? sam, async () => (await db.query(
      `select public.fn_log_acquisition_offer($1,$2,$3,$7,$8,$4,150000,'verbal',$5,$6,'no_motivation',null,null) as r`,
      [org, property, ep, key,
        over.sentAt ?? new Date(Date.now() - HOUR).toISOString(),
        over.followUpAt ?? new Date(Date.now() + 3 * DAY).toISOString(), over.version ?? 0, over.status ?? 'new_lead'])).rows[0].r) as Json;
    return { result: r, key };
  };
  const offer = async (id: string) => (await db.query('select * from public.acquisition_offers where id=$1', [id])).rows[0];
  const tasksForChain = async (c: string) => (await db.query('select * from public.tasks where calendar_chain_id=$1 order by created_at, id', [c])).rows;
  const flags = async () => (await db.query("select coalesce(current_setting('sandra.allow_appointment_time_move',true),'') as a, coalesce(current_setting('sandra.allow_offer_follow_up_close',true),'') as b")).rows[0];
  return { org, jarrad, sam, prop, as, expectError, episode, logOffer, offer, tasksForChain, flags };
}

it('logging an offer creates its phone follow-up in the same transaction and stores the chain', async () => {
  await withDb([...chain, offerMigration], async (db) => {
    const w = await world(db);
    const property = await w.prop('a');
    const followUp = new Date(Date.now() + 3 * DAY).toISOString();
    const sentAt = new Date(Date.now() - HOUR).toISOString();
    const { result, key } = await w.logOffer(property, { followUpAt: followUp, sentAt });
    expect(result).toMatchObject({ ok: true, duplicate: false, propertyId: property });
    const offer = await w.offer(result.offerId);
    expect(offer.follow_up_calendar_chain_id).toBeTruthy();
    expect(new Date(offer.follow_up_at).toISOString()).toBe(followUp);
    const tasks = await w.tasksForChain(offer.follow_up_calendar_chain_id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ type: 'appointment', mode: 'phone', status: 'open', title: 'Offer follow-up', assignee_id: w.sam, related_property_id: property, source_key: `offer_follow_up:${result.offerId}` });
    expect(new Date(tasks[0].due_at).toISOString()).toBe(followUp);
    expect(new Date(tasks[0].end_at).getTime() - new Date(tasks[0].due_at).getTime()).toBe(15 * 60_000);
    expect((await db.query('select * from public.task_calendar_mutations where source_task_id=$1', [tasks[0].id])).rows).toHaveLength(0);
    expect((await db.query('select accountable_user_id, source from public.acquisition_appointment_attribution where task_id=$1', [tasks[0].id])).rows)
      .toEqual([{ accountable_user_id: w.sam, source: 'booking_insert' }]);

    // A second offer while one is pending is refused and creates nothing.
    await w.expectError(() => w.logOffer(property, { version: 1, status: 'offer_sent' }), /PENDING_OFFER_EXISTS/);
    // Replaying the same key returns the stored result and creates no second task.
    const replay = await w.logOffer(property, { key, followUpAt: followUp, sentAt });
    expect(replay.result).toMatchObject({ duplicate: true, offerId: result.offerId });
    expect(await w.tasksForChain(offer.follow_up_calendar_chain_id)).toHaveLength(1);
    expect((await db.query("select count(*)::int n from public.tasks where org_id=$1 and title='Offer follow-up'", [w.org])).rows[0].n).toBe(1);
  });
});

it('a back-dated offer gets a past (overdue) follow-up and the caller role claim is restored', async () => {
  await withDb([...chain, offerMigration], async (db) => {
    const w = await world(db);
    const property = await w.prop('past');
    const followUp = new Date(Date.now() - 2 * DAY).toISOString();
    const { result } = await w.logOffer(property, { sentAt: new Date(Date.now() - 3 * DAY).toISOString(), followUpAt: followUp });
    const offer = await w.offer(result.offerId);
    const [task] = await w.tasksForChain(offer.follow_up_calendar_chain_id);
    expect(new Date(task.due_at).toISOString()).toBe(followUp);
    expect((await db.query("select coalesce(current_setting('request.jwt.claim.role', true), '') as r")).rows[0].r).not.toBe('service_role');
  });
});

it('a DNC-locked lead raises DNC_LOCKED before any task is created', async () => {
  await withDb([...chain, offerMigration], async (db) => {
    const w = await world(db);
    const property = await w.prop('dnc');
    await db.query("set local session_replication_role='replica'");
    await db.query('update public.properties set is_dnc_locked=true where id=$1', [property]);
    await db.query("set local session_replication_role='origin'");
    await w.expectError(() => w.logOffer(property), /DNC_LOCKED/);
    expect((await db.query('select count(*)::int n from public.tasks where org_id=$1', [w.org])).rows[0].n).toBe(0);
  });
});

it('reschedule moves follow_up_at, a time before the offer is refused, cancel is blocked, held completion is allowed', async () => {
  await withDb([...chain, offerMigration], async (db) => {
    const w = await world(db);
    const property = await w.prop('r');
    const sent = new Date(Date.now() - 30 * 60_000);
    const { result } = await w.logOffer(property, { sentAt: sent.toISOString() });
    const first = await w.offer(result.offerId);
    const chainId = first.follow_up_calendar_chain_id as string;
    const open = async () => (await db.query("select id, due_at from public.tasks where calendar_chain_id=$1 and status='open'", [chainId])).rows[0];
    const t0 = await open();

    // Reschedule as the assignee: follow_up_at follows the successor, the offer keeps the chain.
    const newStart = new Date(Date.now() + 5 * DAY);
    const resched = await w.as('authenticated', w.sam, async () => (await db.query(
      'select public.fn_reschedule_appointment($1,$2,$3,$4,$5) as r',
      [t0.id, newStart.toISOString(), new Date(newStart.getTime() + 15 * 60_000).toISOString(), 'America/Chicago', randomUUID()])).rows[0].r) as Json;
    const moved = await w.offer(result.offerId);
    expect(new Date(moved.follow_up_at).toISOString()).toBe(newStart.toISOString());
    expect(moved.follow_up_calendar_chain_id).toBe(chainId);
    const t1 = await open();
    expect(t1.id).toBe(resched.task_id);

    // Rescheduling to a time at or before the offer was sent is refused (the whole reschedule rolls back).
    const early = new Date(sent.getTime() - 10 * 60_000);
    await w.expectError(() => w.as('authenticated', w.sam, async () => db.query(
      'select public.fn_reschedule_appointment($1,$2,$3,$4,$5)',
      [t1.id, early.toISOString(), new Date(early.getTime() + 15 * 60_000).toISOString(), 'America/Chicago', randomUUID()])),
    /OFFER_FOLLOW_UP_BEFORE_SENT/);
    expect((await w.offer(result.offerId)).follow_up_at).toEqual(moved.follow_up_at);

    // Cancelling the follow-up of a pending offer is refused.
    await w.expectError(() => w.as('authenticated', w.sam, async () => db.query('select public.fn_cancel_appointment($1)', [t1.id])), /OFFER_FOLLOW_UP_PENDING/);

    // Completing as held stays allowed and leaves follow_up_at as history.
    await w.as('authenticated', w.sam, async () => db.query("select public.fn_complete_appointment($1,'held')", [t1.id]));
    const after = await w.offer(result.offerId);
    expect(after.follow_up_at).toEqual(moved.follow_up_at);
    expect(after.outcome).toBe('pending');
  });
});

it('an offer leaving pending cancels the open follow-up, resets both settings, and later cancels are guarded again', async () => {
  await withDb([...chain, offerMigration], async (db) => {
    const w = await world(db);
    const pa = await w.prop('decline');
    const pb = await w.prop('accept');
    const pc = await w.prop('later');
    const a = await w.logOffer(pa);
    const b = await w.logOffer(pb);
    const offerA = await w.offer(a.result.offerId);
    const offerB = await w.offer(b.result.offerId);

    const epA = await w.episode(pa);
    // Decline through the command: the follow-up is cancelled/cancelled, not held.
    await w.as('authenticated', w.jarrad, async () => db.query(
      'select public.fn_decline_acquisition_offer($1,$2,$3,1,$4,$5,$6,now())',
      [w.org, pa, epA, 'offer_sent', randomUUID(), a.result.offerId]));
    const declinedTasks = await w.tasksForChain(offerA.follow_up_calendar_chain_id);
    expect(declinedTasks).toHaveLength(1);
    expect(declinedTasks[0]).toMatchObject({ status: 'cancelled', outcome: 'cancelled' });
    expect(await w.flags()).toEqual({ a: '', b: '' });

    // Any other path that leaves 'pending' (here a direct accepted update) does the same.
    await db.query("update public.acquisition_offers set outcome='accepted', outcome_at=now(), outcome_by=$2 where id=$1", [b.result.offerId, w.sam]);
    const acceptedTasks = await w.tasksForChain(offerB.follow_up_calendar_chain_id);
    expect(acceptedTasks[0]).toMatchObject({ status: 'cancelled', outcome: 'cancelled' });
    expect(await w.flags()).toEqual({ a: '', b: '' });

    // The bypass did not leak: a fresh pending offer's follow-up cannot be cancelled in this transaction.
    const c = await w.logOffer(pc);
    const offerC = await w.offer(c.result.offerId);
    const [taskC] = await w.tasksForChain(offerC.follow_up_calendar_chain_id);
    await w.expectError(() => w.as('authenticated', w.sam, async () => db.query('select public.fn_cancel_appointment($1)', [taskC.id])), /OFFER_FOLLOW_UP_PENDING/);
  });
});

it('the backfill gives pending offers a follow-up, never in the past, keeps KPIs, and rolls back conflict-safely', async () => {
  await withDb([...chain, offerMigration], async (db) => {
    const w = await world(db);
    const overdueProp = await w.prop('overdue');
    const soonProp = await w.prop('soon');
    const laterProp = await w.prop('later');
    const dncProp = await w.prop('dnc');
    const doneProp = await w.prop('done');
    await db.query("set local session_replication_role='replica'");
    await db.query('update public.properties set is_dnc_locked=true where id=$1', [dncProp]);
    await db.query("set local session_replication_role='origin'");
    const insertOffer = async (property: string, sentDaysAgo: number, followUpFromNow: number, outcome = 'pending') => {
      const id = randomUUID();
      await db.query(
        `insert into public.acquisition_offers(id,org_id,property_id,assignment_episode_id,actor_user_id,amount_cents,sent_via,sent_at,follow_up_at,outcome,outcome_at,outcome_by,idempotency_key)
         values ($1,$2,$3,$4,$5,100000,'verbal',$6,$7,$8,$9,$10,$11)`,
        [id, w.org, property, await w.episode(property), w.sam,
          new Date(Date.now() - sentDaysAgo * DAY).toISOString(), new Date(Date.now() + followUpFromNow).toISOString(), outcome,
          outcome === 'pending' ? null : new Date().toISOString(), outcome === 'pending' ? null : w.sam, randomUUID()]);
      return id;
    };
    const overdue = await insertOffer(overdueProp, 25, -20 * DAY);
    const soon = await insertOffer(soonProp, 1, 2 * HOUR);
    const later = await insertOffer(laterProp, 1, 6 * DAY);
    const locked = await insertOffer(dncProp, 3, -DAY);
    await insertOffer(doneProp, 5, -2 * DAY, 'declined');

    const call = (apply: boolean, fingerprint: string | null = null, actor = w.jarrad) => w.as('service_role', null, async () =>
      (await db.query('select public.fn_my_leads_backfill_offer_follow_ups($1,$2,$3,$4) as r', [w.org, actor, apply, fingerprint])).rows[0].r) as Promise<Json>;
    const info = (run: string) => w.as('service_role', null, async () => (await db.query('select public.fn_my_leads_housekeeping_run_info($1,$2) as r', [run, w.org])).rows[0].r) as Promise<Json>;
    const rollback = async (run: string) => w.as('service_role', null, async () =>
      (await db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as r', [run, w.org, (await info(run)).fingerprint])).rows[0].r) as Promise<Json>;
    const kpis = () => w.as('authenticated', w.jarrad, async () => {
      const v = (await db.query("select public.fn_get_acquisition_kpis($1,$2,now()-interval '60 days',now()-interval '1 day') as v", [w.org, w.jarrad])).rows[0].v;
      delete v.asOf;
      return v;
    });
    const offers = async () => (await db.query('select id, follow_up_at, follow_up_calendar_chain_id, outcome from public.acquisition_offers where org_id=$1 order by id', [w.org])).rows;

    const before = await offers();
    const kpiBefore = await kpis();

    const preview = await call(false);
    expect(preview).toMatchObject({ kind: 'offer_follow_up_backfill', candidates: 3, overdue: 1, overdueMovedToNextNine: 1, keptExact: 2, skippedLocked: 1 });
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(preview.nextNine).getTime()).toBeGreaterThan(Date.now());
    expect(await offers()).toEqual(before);
    expect((await db.query('select count(*)::int n from public.my_leads_housekeeping_runs')).rows[0].n).toBe(0);

    await w.expectError(() => call(true), /FINGERPRINT_REQUIRED/);
    await w.expectError(() => call(true, 'a'.repeat(64)), /FINGERPRINT_MISMATCH/);
    await w.expectError(() => call(false, null, randomUUID()), /INVALID_ACTOR/);
    await w.expectError(() => w.as('authenticated', w.jarrad, async () => db.query('select public.fn_my_leads_backfill_offer_follow_ups($1,$2)', [w.org, w.jarrad])), /permission denied|service role/);
    // A substituted cohort (same count, different rows) makes the preview stale.
    await db.query('savepoint sub');
    await db.query("update public.acquisition_offers set follow_up_at=follow_up_at+interval '1 minute' where id=$1", [later]);
    await w.expectError(() => call(true, preview.fingerprint), /FINGERPRINT_MISMATCH/);
    await db.query('rollback to savepoint sub');

    const applied = await call(true, preview.fingerprint);
    expect(applied).toMatchObject({ created: 3, keptExact: 2, movedToNextNine: 1, skipped: [] });
    const run = applied.runId as string;
    const after = await offers();
    for (const o of after) {
      const was = before.find((b) => b.id === o.id)!;
      expect(o.follow_up_at).toEqual(was.follow_up_at); // history is untouched
    }
    const chainOf = (id: string) => after.find((o) => o.id === id)!.follow_up_calendar_chain_id as string;
    expect(chainOf(locked)).toBeNull();
    expect(chainOf(overdue)).toBeTruthy();
    const taskFor = async (id: string) => (await db.query('select * from public.tasks where calendar_chain_id=$1', [chainOf(id)])).rows[0];
    const tOverdue = await taskFor(overdue), tSoon = await taskFor(soon), tLater = await taskFor(later);
    // Overdue offer: next 09:00 America/Chicago after the run, never in the past.
    expect(new Date(tOverdue.due_at).toISOString()).toBe(new Date(preview.nextNine).toISOString());
    expect(new Date(tOverdue.due_at).getTime()).toBeGreaterThan(Date.now());
    const nine = (await db.query("select (($1::timestamptz) at time zone 'America/Chicago')::time::text as t", [tOverdue.due_at])).rows[0].t;
    expect(nine).toBe('09:00:00');
    // Not-yet-due offers keep their own follow_up_at exactly (even one due before the next 09:00).
    expect(new Date(tSoon.due_at).toISOString()).toBe(new Date(before.find((o) => o.id === soon)!.follow_up_at).toISOString());
    expect(new Date(tLater.due_at).toISOString()).toBe(new Date(before.find((o) => o.id === later)!.follow_up_at).toISOString());
    expect(tOverdue).toMatchObject({ type: 'appointment', mode: 'phone', status: 'open', title: 'Offer follow-up', assignee_id: w.sam });
    const attr = (await db.query("select source from public.acquisition_appointment_attribution where task_id = any($1::uuid[])", [[tOverdue.id, tSoon.id, tLater.id]])).rows;
    expect(attr).toEqual([{ source: 'offer_backfill' }, { source: 'offer_backfill' }, { source: 'offer_backfill' }]);
    // KPIs for a closed historical window are identical before and after.
    expect(await kpis()).toEqual(kpiBefore);
    // Idempotent: nothing left to do.
    const again = await call(false);
    expect(again.candidates).toBe(0);
    expect(await call(true, again.fingerprint)).toMatchObject({ noop: true, runId: null });

    // Rollback: a follow-up the rep rescheduled after the run is skipped; the rest are undone.
    const newStart = new Date(Date.now() + 9 * DAY);
    await w.as('authenticated', w.sam, async () => db.query(
      'select public.fn_reschedule_appointment($1,$2,$3,$4,$5)',
      [tLater.id, newStart.toISOString(), new Date(newStart.getTime() + 15 * 60_000).toISOString(), 'America/Chicago', randomUUID()]));
    const flagsBefore = await w.flags();
    const rolled = await rollback(run);
    expect(rolled).toMatchObject({ restored: 2, status: 'applied' });
    expect(rolled.notRestored).toHaveLength(1);
    expect(rolled.notRestored[0]).toMatchObject({ offer: later });
    const end = await offers();
    expect(end.find((o) => o.id === overdue)!.follow_up_calendar_chain_id).toBeNull();
    expect(end.find((o) => o.id === soon)!.follow_up_calendar_chain_id).toBeNull();
    expect(end.find((o) => o.id === later)!.follow_up_calendar_chain_id).toBe(chainOf(later));
    expect((await taskFor(overdue))).toMatchObject({ status: 'cancelled', outcome: 'cancelled' });
    expect((await db.query("select count(*)::int n from public.acquisition_appointment_attribution where task_id = any($1::uuid[]) and source='offer_backfill'", [[tOverdue.id, tSoon.id]])).rows[0].n).toBe(0);
    expect(await w.flags()).toEqual(flagsBefore); // the rollback restores the setting it found
  });
});

it('the rollback twin restores the previous offer function and drops the triggers and column', async () => {
  await withDb([...chain, offerMigration, offerRollback], async (db) => {
    const w = await world(db);
    const exists = async (sql: string) => (await db.query(sql)).rows[0].n as number;
    expect(await exists("select count(*)::int n from pg_trigger where tgname like 'trg_%offer_follow_up%' or tgname='trg_acquisition_offer_close_follow_up'")).toBe(0);
    expect(await exists("select count(*)::int n from information_schema.columns where table_name='acquisition_offers' and column_name='follow_up_calendar_chain_id'")).toBe(0);
    expect(await exists("select count(*)::int n from pg_proc where proname in ('fn_my_leads_backfill_offer_follow_ups','my_leads_offer_backfill_candidate_ids')")).toBe(0);
    expect(await exists("select count(*)::int n from pg_proc where proname='fn_log_acquisition_offer' and prosrc like '%fn_create_next_step%'")).toBe(0);
    // The old behavior is back: an offer is logged with no follow-up task.
    const property = await w.prop('rb');
    const { result } = await w.logOffer(property);
    expect(result.ok).toBe(true);
    expect(await exists(`select count(*)::int n from public.tasks where org_id='${w.org}'`)).toBe(0);
  });
});
