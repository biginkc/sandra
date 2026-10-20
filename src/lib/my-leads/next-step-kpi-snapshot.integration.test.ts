import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { applyMyLeadsChain } from '@tests/integration/my-leads-housekeeping-fixture';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

// Plan item 1a.12: the housekeeping tools (close attempts, reassign, relabel) must not rewrite history.
// One rolled-back transaction replays the P1e and P1a-core migrations over a seeded org.
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const DAY = 86_400_000;
const HOUR = 3_600_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

it('keeps historical KPI windows identical across close-attempts, reassign and relabel, and moves only the live window', async () => {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await applyMyLeadsChain(db, ['tools', 'reassign', 'outcome', 'schema', 'relabel']);

    const base = (await db.query('select statement_timestamp() as t')).rows[0].t as Date;
    const at = (offsetMs: number) => new Date(base.getTime() + offsetMs).toISOString();

    const org = randomUUID(), jarrad = randomUUID(), maria = randomUUID();
    for (const id of [jarrad, maria]) await db.query('insert into auth.users(id) values ($1)', [id]);
    await db.query("insert into public.organizations(id,name) values ($1,'KPI snapshot')", [org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [jarrad, org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [maria, org]);
    await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [jarrad]);
    for (const id of [jarrad, maria]) {
      await db.query("select set_config('my_leads.designation_update',$1,true)", [`${jarrad}:${org}:${id}`]);
      await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [id, org]);
    }
    await db.query("select set_config('my_leads.designation_update','',true)");
    // Stays valid once the retire trigger is in the chain.
    await db.query("select set_config('sandra.allow_retired_task_type','on',true)");

    const prop = async (key: string, assignee: string, stage: string | null) => {
      const id = randomUUID();
      await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,$3,'MO','new_lead',$4)", [id, org, `${key} Main`, assignee]);
      if (stage) {
        await db.query('insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at) values ($1,$2,$3,$4)', [id, org, stage, at(-12 * HOUR)]);
      }
      return id;
    };
    const L = {
      contactedCb: await prop('contacted-callback', jarrad, 'contacted'),   // only future step is a legacy callback
      contactedAppt: await prop('contacted-appt', jarrad, 'contacted'),     // has a real future appointment
      contactedNone: await prop('contacted-none', jarrad, 'contacted'),     // no future step at all
      needsOffer: await prop('needs-offer', jarrad, 'needs_offer'),
      offerSent: await prop('offer-sent', jarrad, 'offer_sent'),
      followUp: await prop('follow-up', jarrad, null),
      snoozed: await prop('snoozed', jarrad, null),
      done: await prop('done', jarrad, null),
      pastDue: await prop('past-due', jarrad, null),
      appts: await prop('appts', jarrad, null),
      maria: await prop('maria', maria, null),                              // reassigned to Jarrad by the run
    };

    // Episodes: put first-call facts into the two historical windows and the live window.
    const episode = (property: string, assignedMs: number, firstCallMs: number | null) => db.query(
      `update public.acquisition_assignment_episodes set assigned_at=$1, first_call_started_at=$2, first_call_actor_user_id=$3
       where org_id=$4 and property_id=$5 and ended_at is null`,
      [at(assignedMs), firstCallMs === null ? null : at(firstCallMs), firstCallMs === null ? null : jarrad, org, property]);
    await episode(L.contactedCb, -20 * DAY, -20 * DAY + 2 * HOUR);   // window 1, sampled
    await episode(L.contactedNone, -10 * DAY, null);                  // window 2, pending
    await episode(L.contactedAppt, -9 * DAY, -9 * DAY + HOUR);        // window 2, sampled
    await episode(L.offerSent, -2 * HOUR, null);                      // live, pending
    await episode(L.needsOffer, -3 * HOUR, -2 * HOUR);                // live, sampled

    const attempt = async (property: string, outcome: string | null, offsetMs: number, source = 'sandra') => {
      await db.query(
        "insert into public.acquisition_attempts(id,org_id,property_id,actor_user_id,attempt_kind,source,outcome,occurred_at,provider_attempt_key,idempotency_key) values ($1,$2,$3,$4,'call',$5,$6,$7,$8,$9)",
        [randomUUID(), org, property, jarrad, source, outcome, at(offsetMs), source === 'dialpad' ? `dialpad-cti:${randomUUID()}` : `snap-${randomUUID()}`, randomUUID()]);
    };
    // Window 1 (-30d..-15d): reached, no_answer, voicemail and one pending attempt older than 7 days.
    await attempt(L.contactedCb, 'reached', -20 * DAY + 2 * HOUR);
    await attempt(L.contactedCb, 'no_answer', -19 * DAY);
    await attempt(L.contactedCb, 'voicemail', -18 * DAY);
    await attempt(L.contactedCb, null, -25 * DAY);
    // Window 2 (-14d..-1d): reached, a pending Sandra attempt (closed by the run) and a pending Dialpad one (left alone).
    await attempt(L.contactedAppt, 'reached', -9 * DAY + HOUR);
    await attempt(L.contactedNone, null, -9 * DAY);
    await attempt(L.contactedNone, null, -9 * DAY, 'dialpad');
    // Live window: reached, no_answer, voicemail, and a fresh pending attempt that is not old enough to close.
    await attempt(L.needsOffer, 'reached', -2 * HOUR);
    await attempt(L.needsOffer, 'no_answer', -3 * HOUR);
    await attempt(L.offerSent, 'voicemail', -90 * 60_000);
    await attempt(L.offerSent, null, -HOUR);

    const offer = async (property: string, outcome: 'pending' | 'accepted' | 'declined', sentMs: number) => {
      await db.query(
        `insert into public.acquisition_offers(org_id,property_id,actor_user_id,amount_cents,sent_via,sent_at,follow_up_at,outcome,outcome_at,outcome_by,idempotency_key)
         values ($1,$2,$3,15000000,'verbal',$4,$5,$6,$7,$8,$9)`,
        [org, property, jarrad, at(sentMs), at(sentMs + DAY), outcome,
          outcome === 'pending' ? null : at(sentMs + HOUR), outcome === 'pending' ? null : jarrad, randomUUID()]);
    };
    await offer(L.needsOffer, 'declined', -12 * DAY);   // window 2, decided
    await offer(L.contactedAppt, 'accepted', -22 * DAY); // window 1, decided
    await offer(L.offerSent, 'pending', -2 * HOUR);      // live, pending

    const appointment = async (property: string, dueMs: number, status: 'open' | 'completed' | 'cancelled', outcome: string | null) => {
      const id = randomUUID();
      // Appointments are created open (attribution is captured at insert); history is stamped afterwards.
      await db.query(
        `insert into public.tasks(id,org_id,type,status,title,due_at,end_at,assignee_id,created_by,calendar_chain_id,related_property_id)
         values ($1,$2,'appointment','open','Appt',$3,$4,$5,$5,$6,$7)`,
        [id, org, at(dueMs), at(dueMs + 30 * 60_000), jarrad, randomUUID(), property]);
      if (status === 'open') return;
      await db.query("set local session_replication_role='replica'");
      await db.query(
        'update public.tasks set status=$2, outcome=$3, completed_at=$4, completed_by=$5 where id=$1',
        [id, status, outcome, status === 'completed' ? at(dueMs + HOUR) : null, status === 'completed' ? jarrad : null]);
      await db.query("set local session_replication_role='origin'");
    };
    await appointment(L.appts, -20 * DAY, 'completed', 'held');          // window 1
    await appointment(L.appts, -10 * DAY, 'completed', 'no_show');       // window 2
    await appointment(L.appts, -9 * DAY, 'completed', 'rescheduled');    // window 2, excluded by the KPI
    await appointment(L.appts, -8 * DAY, 'cancelled', 'cancelled');      // window 2, excluded by the KPI
    await appointment(L.appts, -3 * HOUR, 'completed', 'held');          // live, held
    await appointment(L.contactedAppt, 5 * DAY, 'open', null);           // live, a real future appointment

    // Legacy rows.
    const legacy = async (type: string, property: string, assignee: string, over: { status?: string; dueMs: number; snoozedMs?: number }) => {
      const id = randomUUID();
      const status = over.status ?? 'open';
      await db.query(
        `insert into public.tasks(id,org_id,type,status,title,due_at,snoozed_until,assignee_id,created_by,related_property_id,completed_at,completed_by)
         values ($1,$2,$3,$4,'Legacy',$5,$6,$7,$8,$9,$10,$11)`,
        [id, org, type, status, at(over.dueMs), over.snoozedMs === undefined ? null : at(over.snoozedMs), assignee, jarrad, property,
          status === 'completed' ? at(over.dueMs + HOUR) : null, status === 'completed' ? jarrad : null]);
      return id;
    };
    const t = {
      futureCb: await legacy('callback', L.contactedCb, jarrad, { dueMs: 2 * DAY }),
      futureFu: await legacy('follow_up', L.followUp, jarrad, { dueMs: 3 * DAY }),
      snoozed: await legacy('callback', L.snoozed, jarrad, { status: 'snoozed', dueMs: -DAY, snoozedMs: 4 * DAY }),
      completed: await legacy('callback', L.done, jarrad, { status: 'completed', dueMs: -3 * DAY }),
      pastDue: await legacy('callback', L.pastDue, jarrad, { dueMs: -2 * DAY }),
      maria: await legacy('callback', L.maria, maria, { dueMs: 6 * DAY }),
    };

    const as = async <T>(role: 'authenticated' | 'service_role', fn: () => Promise<T>) => {
      await db.query(`set local role ${role}`);
      await db.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
      try { return await fn(); } finally { await db.query('reset role').catch(() => {}); }
    };
    const window = (startMs: number, endMs: number) => ({ start: at(startMs), end: at(endMs) });
    const windows = { w1: window(-30 * DAY, -15 * DAY), w2: window(-14 * DAY, -DAY), live: window(-DAY, 10 * DAY) };
    const snapshot = () => as('authenticated', async () => {
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [jarrad]);
      const out: Record<string, Json> = {};
      for (const [name, w] of Object.entries(windows)) {
        const v = (await db.query('select public.fn_get_acquisition_kpis($1,$2,$3,$4) as v', [org, jarrad, w.start, w.end])).rows[0].v;
        delete v.asOf;
        out[name] = v;
      }
      return out;
    });
    const rpc = (sql: string, args: unknown[]) => as('service_role', async () => (await db.query(sql, args)).rows[0].r);
    const info = (run: string) => rpc('select public.fn_my_leads_housekeeping_run_info($1,$2) as r', [run, org]);
    const rollback = async (run: string) => rpc('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as r', [run, org, (await info(run)).fingerprint]);
    const taskRow = async (id: string) => (await db.query('select type,status,due_at,end_at,snoozed_until,calendar_chain_id,updated_at from public.tasks where id=$1', [id])).rows[0];
    const attributed = async (id: string) => (await db.query('select count(*)::int n from public.acquisition_appointment_attribution where task_id=$1', [id])).rows[0].n as number;

    const original = await snapshot();
    // Sanity: the seed actually exercises every figure the assertions look at.
    expect(original.w1).toMatchObject({ attempts: 4, reached: 1, pendingOutcomes: 1, firstCallSamples: 1, appointmentsDue: 1, appointmentsHeld: 1, offersSent: 1 });
    expect(original.w2).toMatchObject({ attempts: 3, reached: 1, pendingOutcomes: 2, firstCallSamples: 1, firstCallPending: 1, appointmentsDue: 1, appointmentsHeld: 0, offersSent: 1 });
    expect(original.live).toMatchObject({ attempts: 4, reached: 1, pendingOutcomes: 1, firstCallSamples: 1, firstCallPending: 6, appointmentsDue: 2, appointmentsHeld: 1, offersSent: 1, contactWithoutFollowUp: 2 });

    const beforeRows = { completed: await taskRow(t.completed), pastDue: await taskRow(t.pastDue) };

    // 1. close attempts older than 7 days.
    const closePreview = await rpc('select public.fn_my_leads_housekeeping_close_attempts($1,$2::interval,false,null,null) as r', [org, '7 days']);
    expect(closePreview.count).toBe(2);
    const closed = await rpc('select public.fn_my_leads_housekeeping_close_attempts($1,$2::interval,true,$3,$4) as r', [org, '7 days', closePreview.fingerprint, closePreview.cutoff]);
    expect(closed.closed ?? closed.count).toBe(2);
    const afterClose = await snapshot();

    // 2. reassign Maria's lead (and its callback) to Jarrad.
    const reassignPreview = await rpc('select public.fn_my_leads_housekeeping_reassign($1,$2,$3,false,false,null) as r', [org, jarrad, jarrad]);
    expect(reassignPreview.leadCount).toBe(1);
    const reassigned = await rpc('select public.fn_my_leads_housekeeping_reassign($1,$2,$3,true,false,$4) as r', [org, jarrad, jarrad, reassignPreview.fingerprint]);
    expect(reassigned).toMatchObject({ leadsMoved: 1, tasksMoved: 1 });
    const afterReassign = await snapshot();

    // 3. relabel the open future legacy next steps (Maria's callback is now Jarrad's).
    const relabelPreview = await rpc('select public.fn_my_leads_relabel_open_next_steps($1,$2,false,null,null) as r', [org, jarrad]);
    expect(relabelPreview.candidates).toBe(4);
    const relabeled = await rpc('select public.fn_my_leads_relabel_open_next_steps($1,$2,true,$3,$4) as r', [org, jarrad, relabelPreview.fingerprint, relabelPreview.cutoff]);
    expect(relabeled.converted).toBe(4);
    const afterRelabel = await snapshot();

    // (1) Historical windows: identical apart from pendingOutcomes, which drops by exactly the closed attempts inside the window.
    for (const name of ['w1', 'w2'] as const) {
      expect(afterClose[name]).toEqual({ ...original[name], pendingOutcomes: original[name].pendingOutcomes - 1 });
      expect(afterReassign[name]).toEqual(afterClose[name]);
      // Deviation from the plan text: contactWithoutFollowUp reads the live queue (not the window), so it
      // is the same figure in every window and falls by one there too; every window-scoped figure is identical.
      expect(afterRelabel[name]).toEqual({ ...afterClose[name], contactWithoutFollowUp: afterClose[name].contactWithoutFollowUp - 1 });
    }
    expect(afterClose.w1.pendingOutcomes).toBe(0);
    expect(afterClose.w2.pendingOutcomes).toBe(1); // the pending Dialpad attempt is not a Sandra attempt
    expect(afterClose.live.pendingOutcomes).toBe(original.live.pendingOutcomes);

    // (2) First-call figures for Jarrad are untouched by the reassign, in every window.
    for (const name of ['w1', 'w2', 'live'] as const) {
      expect(afterReassign[name].firstCallSamples).toBe(afterClose[name].firstCallSamples);
      expect(afterReassign[name].firstCallPending).toBe(afterClose[name].firstCallPending);
    }

    // (3) Live window: the four relabeled rows are all due inside it; one contacted lead had only a legacy callback.
    const live = afterRelabel.live, liveBefore = original.live;
    expect(live.appointmentsDue).toBe(liveBefore.appointmentsDue + 4);
    expect(live.contactWithoutFollowUp).toBe(liveBefore.contactWithoutFollowUp - 1);
    for (const key of ['appointmentsHeld', 'attempts', 'reached', 'offersSent'] as const) expect(live[key]).toBe(liveBefore[key]);

    // (5) Completed and past-due legacy rows are not converted and not attributed.
    for (const [name, id] of [['completed', t.completed], ['pastDue', t.pastDue]] as const) {
      const row = await taskRow(id);
      expect(row).toEqual(beforeRows[name]);
      expect(row.type).toBe('callback');
      expect(await attributed(id)).toBe(0);
    }
    for (const id of [t.futureCb, t.futureFu, t.snoozed, t.maria]) {
      expect((await taskRow(id)).type).toBe('appointment');
      expect(await attributed(id)).toBe(1);
    }

    // (4) Rolling back all three runs, newest first, returns every window to the original values.
    expect(await rollback(relabeled.runId)).toMatchObject({ status: 'rolled_back', notRestored: [] });
    expect(await rollback(reassigned.runId)).toMatchObject({ status: 'rolled_back' });
    expect(await rollback(closed.runId)).toMatchObject({ status: 'rolled_back' });
    expect(await snapshot()).toEqual(original);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
});
