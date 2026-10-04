import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { applyP1e } from '@tests/integration/my-leads-housekeeping-fixture';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

it('reassigns queue leads and open tasks, keeps the first-call clock, and rolls back exactly', async () => {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await applyP1e(db, 'reassign');

    const org = randomUUID(), jarrad = randomUUID(), maria = randomUUID(), mel = randomUUID(), va = randomUUID();
    for (const id of [jarrad, maria, mel, va]) await db.query('insert into auth.users(id) values ($1)', [id]);
    await db.query("insert into public.organizations(id,name) values ($1,'Housekeeping')", [org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [jarrad, org]);
    for (const id of [maria, mel, va]) await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [id, org]);
    await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [jarrad]);
    for (const id of [jarrad, maria, mel]) {
      await db.query("select set_config('my_leads.designation_update',$1,true)", [`${jarrad}:${org}:${id}`]);
      await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [id, org]);
    }
    await db.query("select set_config('my_leads.designation_update','',true)");

    const prop = async (key: string, assignee: string, status = 'new_lead') => {
      const id = randomUUID();
      await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,$3,'MO',$4,$5)", [id, org, `${key} Main`, status, assignee]);
      return id;
    };
    const mariaA = await prop('mariaA', maria);
    const melA = await prop('melA', mel);
    const melB = await prop('melB', mel);
    const jarradOwn = await prop('jarrad', jarrad);
    const melClosed = await prop('melClosed', mel, 'closed'); // not in the queue: must not move
    const task = async (type: string, assignee: string, property: string, extra: Record<string, unknown> = {}) => {
      const id = randomUUID();
      const due = new Date(Date.now() + 86_400_000).toISOString();
      if (type === 'appointment') {
        await db.query(
          "insert into public.tasks(id,org_id,type,status,title,due_at,end_at,assignee_id,created_by,calendar_chain_id,related_property_id) values ($1,$2,'appointment','open','Appt',$3,$4,$5,$6,$7,$8)",
          [id, org, due, new Date(Date.parse(due) + 1_800_000).toISOString(), assignee, jarrad, randomUUID(), property]);
      } else {
        await db.query(
          'insert into public.tasks(id,org_id,type,status,title,due_at,assignee_id,created_by,related_property_id,contact_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [id, org, type, extra.status ?? 'open', 'Task', due, assignee, jarrad, property, extra.contact ?? null]);
      }
      return id;
    };
    const mariaCustom = await task('custom', maria, mariaA);
    const melFollow = await task('follow_up', mel, melA);
    const melAppt = await task('appointment', mel, melB);
    const melClosedTask = await task('custom', mel, melClosed);
    const vaTask = await task('custom', va, melA); // a VA's task on a scoped lead: left alone
    const melDone = await task('custom', mel, melA, { status: 'completed' });
    // A task whose contact became DNC-locked cannot be updated: reported, not fatal.
    const contact = randomUUID();
    await db.query("insert into public.contacts(id,org_id,first_name,last_name) values ($1,$2,'Dee','Enn')", [contact, org]);
    const dncTask = await task('custom', mel, melB, { contact });
    await db.query("set local session_replication_role='replica'");
    await db.query('update public.contacts set do_not_contact=true where id=$1', [contact]);
    await db.query("set local session_replication_role='origin'");

    const as = async <T>(role: 'authenticated' | 'anon' | 'service_role', fn: () => Promise<T>) => {
      await db.query(`set local role ${role}`);
      await db.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
      try { return await fn(); } finally { await db.query('reset role').catch(() => {}); }
    };
    const call = (apply: boolean, keepClock = false, fingerprint: string | null = null) => as('service_role', async () =>
      (await db.query('select public.fn_my_leads_housekeeping_reassign($1,$2,$3,$4,$5,$6) as r', [org, jarrad, jarrad, apply, keepClock, fingerprint])).rows[0].r);
    const applyNow = async (keepClock = false) => call(true, keepClock, (await call(false, keepClock)).fingerprint);
    const info = (run: string, orgId = org) => as('service_role', async () => (await db.query('select public.fn_my_leads_housekeeping_run_info($1,$2) as r', [run, orgId])).rows[0].r);
    const rollback = async (run: string) => as('service_role', async () =>
      (await db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as r', [run, org, (await info(run)).fingerprint])).rows[0].r);
    const expectError = async (run: () => Promise<unknown>, pattern: RegExp) => {
      await db.query('savepoint s');
      let failure: unknown = null;
      try { await run(); } catch (error) { failure = error; }
      await db.query('rollback to savepoint s');
      await db.query('reset role');
      expect(String((failure as Error)?.message)).toMatch(pattern);
    };
    const kpis = () => as('authenticated', async () => {
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [jarrad]);
      const v = (await db.query("select public.fn_get_acquisition_kpis($1,$2,now()-interval '30 days',now()+interval '1 day') as v", [org, jarrad])).rows[0].v;
      return { samples: v.firstCallSamples, pending: v.firstCallPending };
    });
    const state = async () => ({
      props: (await db.query('select id,assigned_user_id from public.properties where org_id=$1 order by id', [org])).rows,
      episodes: (await db.query('select id,property_id,assignee_user_id,eligible,ended_at is null as open from public.acquisition_assignment_episodes where org_id=$1 order by property_id,assigned_at,id', [org])).rows,
      tasks: (await db.query('select id,assignee_id,title,updated_at from public.tasks where org_id=$1 order by id', [org])).rows,
    });
    const finalizeLedger = () => db.query("update public.task_calendar_mutations set phase='finalized' where org_id=$1 and phase<>'finalized'", [org]);

    // Give the original Maria episode a first-call fact so "intact" is observable.
    await db.query("update public.acquisition_assignment_episodes set first_call_started_at=clock_timestamp(), first_call_actor_user_id=$1 where property_id=$2 and ended_at is null", [maria, mariaA]);
    const kpiBefore = await kpis();
    const before = await state();

    // (a) preview returns counts and writes nothing.
    const preview = await call(false);
    expect(preview.leadCount).toBe(3);
    expect(preview.leads).toEqual(expect.arrayContaining([{ from: maria, count: 1 }, { from: mel, count: 2 }]));
    expect(preview.tasks).toMatchObject({ nonAppointment: 3, appointments: 1 });
    expect(preview.tasks.byAssignee).toEqual(expect.arrayContaining([
      { assignee: maria, nonAppointment: 1, appointments: 0 },
      { assignee: mel, nonAppointment: 2, appointments: 1 },
    ]));
    expect(preview.tasks.byAssignee).toHaveLength(2); // the VA is not in the move
    expect(preview.appointmentsInFlight).toBe(0);
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await call(false)).toEqual(preview); // deterministic, so the operator's hash is stable
    expect(await state()).toEqual(before);
    expect((await db.query('select count(*)::int n from public.my_leads_housekeeping_runs')).rows[0].n).toBe(0);

    // B3: apply is fenced to the exact previewed cohort.
    await expectError(() => call(true), /FINGERPRINT_REQUIRED/);
    await expectError(() => call(true, false, 'a'.repeat(64)), /FINGERPRINT_MISMATCH/);
    // Same counts, substituted rows: mariaA leaves the queue, a new Maria lead enters.
    await db.query('savepoint sub');
    await prop('mariaB', maria);
    await db.query("update public.properties set status='closed' where id=$1", [mariaA]);
    expect((await call(false)).leadCount).toBe(3);
    await expectError(() => call(true, false, preview.fingerprint), /FINGERPRINT_MISMATCH/);
    await db.query('rollback to savepoint sub');
    // An edit between preview and apply (same ids, same counts): a task is touched.
    await db.query('savepoint sub');
    await db.query("update public.tasks set title='edited', updated_at=clock_timestamp() where id=$1", [mariaCustom]);
    await expectError(() => call(true, false, preview.fingerprint), /FINGERPRINT_MISMATCH/);
    await db.query('rollback to savepoint sub');
    // A property edit (assignment of a task away from the cohort filter) is fenced too.
    await db.query('savepoint sub');
    await db.query("update public.tasks set status='completed', completed_at=now(), completed_by=$2 where id=$1", [melFollow, jarrad]);
    await expectError(() => call(true, false, preview.fingerprint), /FINGERPRINT_MISMATCH/);
    await db.query('rollback to savepoint sub');
    expect(await state()).toEqual(before);
    // A different org id sees none of this (tenant predicate).
    await expectError(() => as('service_role', () => db.query('select public.fn_my_leads_housekeeping_reassign($1,$2,$3)', [randomUUID(), jarrad, jarrad])), /INVALID_TARGET/);

    // (b) apply.
    const applied = await call(true, false, preview.fingerprint);
    expect(applied).toMatchObject({ leadsMoved: 3, tasksMoved: 2, appointmentsMoved: 1 });
    expect(applied.skipped).toHaveLength(1);
    expect(applied.skipped[0]).toMatchObject({ task: dncTask });
    const run = applied.runId as string;
    const after = await state();
    for (const id of [mariaA, melA, melB]) expect(after.props.find(p => p.id === id).assigned_user_id).toBe(jarrad);
    expect(after.props.find(p => p.id === melClosed).assigned_user_id).toBe(mel);
    expect(after.props.find(p => p.id === jarradOwn).assigned_user_id).toBe(jarrad);
    for (const id of [mariaA, melA, melB]) {
      const eps = after.episodes.filter(e => e.property_id === id);
      expect(eps).toHaveLength(2);
      expect(eps.filter(e => e.open)).toHaveLength(1);
      expect(eps.find(e => e.open)).toMatchObject({ assignee_user_id: jarrad, eligible: false });
    }
    const taskOwner = (id: string) => after.tasks.find(t => t.id === id).assignee_id;
    expect(taskOwner(mariaCustom)).toBe(jarrad);
    expect(taskOwner(melFollow)).toBe(jarrad);
    expect(taskOwner(melAppt)).toBe(jarrad);
    expect(taskOwner(dncTask)).toBe(mel);          // DNC contact: skipped and reported
    expect(taskOwner(melClosedTask)).toBe(mel);    // not a queue lead
    expect(taskOwner(melDone)).toBe(mel);          // completed tasks are history
    expect(taskOwner(vaTask)).toBe(va);            // only the old assignee's tasks move
    const ledger = await db.query("select operation,phase,new_assignee_id from public.task_calendar_mutations where source_task_id=$1 and operation='reassign'", [melAppt]);
    expect(ledger.rows).toEqual([{ operation: 'reassign', phase: 'pending', new_assignee_id: jarrad }]);
    expect((await db.query("select current_setting('request.jwt.claim.sub',true) as s")).rows[0].s).toBe(jarrad);
    // B4: created vs updated rows are recorded separately and every changed row has an image.
    const images = await db.query("select table_name,before->>'op' as op,count(*)::int n from public.my_leads_housekeeping_before_images where run_id=$1 group by 1,2 order by 1,2", [run]);
    expect(images.rows).toEqual([
      { table_name: 'acquisition_assignment_episodes', op: 'created', n: 3 },
      { table_name: 'acquisition_assignment_episodes', op: 'updated', n: 3 },
      { table_name: 'properties', op: 'updated', n: 3 },
      { table_name: 'tasks', op: 'updated', n: 3 }, // the DNC task image is rolled back with its failed step
    ]);
    const apptImage = (await db.query("select before from public.my_leads_housekeeping_before_images where run_id=$1 and table_name='tasks' and row_id=$2", [run, melAppt])).rows[0].before;
    expect(apptImage).toMatchObject({ assignee_id: mel, type: 'appointment', calendar_generation: 0, applied_generation: 1 });
    expect(apptImage.due_at).toBeTruthy();
    expect(apptImage.end_at).toBeTruthy();

    // (g) the first-call clock and KPI samples did not restart.
    expect(await kpis()).toEqual(kpiBefore);

    // (c) a second apply is a no-op.
    expect(await applyNow()).toMatchObject({ noop: true, runId: null });
    expect((await db.query('select count(*)::int n from public.my_leads_housekeeping_runs')).rows[0].n).toBe(1);

    // (d) rollback restores owner, original episode (clock intact), and task assignees exactly.
    expect(await info(run)).toMatchObject({ run: { kind: 'reassign', status: 'applied' } });
    await expectError(() => info(run, randomUUID()), /RUN_NOT_FOUND/);
    await expectError(() => as('service_role', () => db.query('select public.fn_my_leads_housekeeping_rollback($1,$2)', [run, org])), /FINGERPRINT_REQUIRED/);
    await expectError(() => as('service_role', () => db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3)', [run, randomUUID(), 'x'])), /RUN_NOT_FOUND/);
    // Calendar sync for the forward move has not run: the appointment is reported, not forced.
    const blocked = await rollback(run);
    expect(blocked).toMatchObject({ status: 'applied', restored: 5 });
    expect(blocked.notRestored).toEqual([expect.objectContaining({ task: melAppt, reason: expect.stringMatching(/calendar sync in progress/) })]);
    await finalizeLedger();
    const rolled = await rollback(run);
    expect(rolled).toMatchObject({ status: 'rolled_back', restored: 1, alreadyRestored: 5, notRestored: [] });
    expect((await state()).props).toEqual(before.props);
    expect((await state()).episodes).toEqual(before.episodes);
    expect((await state()).tasks.map(t => [t.id, t.assignee_id])).toEqual(before.tasks.map(t => [t.id, t.assignee_id]));
    const restoredEp = (await db.query('select first_call_started_at,first_call_actor_user_id from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null', [mariaA])).rows[0];
    expect(restoredEp.first_call_actor_user_id).toBe(maria);
    expect(restoredEp.first_call_started_at).not.toBeNull();
    expect((await db.query('select status from public.my_leads_housekeeping_runs where id=$1', [run])).rows[0].status).toBe('rolled_back');
    expect((await db.query("select count(*)::int n from public.task_calendar_mutations where source_task_id=$1 and operation='reassign'", [melAppt])).rows[0].n).toBe(2);
    expect(await as('service_role', async () => (await db.query('select public.fn_my_leads_housekeeping_rollback($1,$2) as r', [run, org])).rows[0].r)).toMatchObject({ noop: true });

    // B4: a second run, with user activity after it. Rollback skips those rows and reports them.
    const runB = (await applyNow()).runId as string;
    await finalizeLedger();
    const epOf = async (property: string) => (await db.query('select id from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null', [property])).rows[0].id as string;
    // 1) an attempt was logged on a reassigned lead's new episode.
    await db.query(
      "insert into public.acquisition_attempts(org_id,property_id,assignment_episode_id,actor_user_id,attempt_kind,source,outcome,occurred_at,provider_attempt_key,idempotency_key) values ($1,$2,$3,$4,'call','sandra','reached',now(),$5,$6)",
      [org, mariaA, await epOf(mariaA), jarrad, `hk-${randomUUID()}`, randomUUID()]);
    // 2) a permanent Dialpad intent references another reassigned lead.
    const intentEpisode = await epOf(melA);
    await db.query("set local session_replication_role='replica'");
    await db.query(
      "insert into public.dialpad_call_intents(org_id,connection_id,rep_user_id,binding_id,dialpad_user_id,property_id,contact_id,phone_slot,destination_e164,assignment_episode_id,custom_data,idempotency_key,request_hash,expires_at) values ($1,$2,$3,$4,'1',$5,$6,1,'+15555550100',$7,$8,$9,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',now()+interval '1 hour')",
      [org, randomUUID(), jarrad, randomUUID(), melA, randomUUID(), intentEpisode, `sandra.dialpad.v1.${'a'.repeat(48)}`, randomUUID()]);
    await db.query("set local session_replication_role='origin'");
    // 3) the user edited a moved task after the run.
    await db.query("update public.tasks set title='user edit', updated_at=clock_timestamp()+interval '1 second' where id=$1", [melFollow]);
    const partial = await rollback(runB);
    expect(partial.status).toBe('applied');
    const reasons = Object.fromEntries((partial.notRestored as Array<Record<string, string>>).map(n => [n.property ?? n.task, n.reason]));
    expect(reasons[mariaA]).toMatch(/WORK_RECORDED: attempt_recorded/);
    expect(reasons[melA]).toMatch(/WORK_RECORDED: dialpad_intent_reference/);
    expect(reasons[melFollow]).toBe('EDITED_SINCE');
    expect(reasons[mariaCustom]).toBe('LEAD_NOT_RESTORED'); // a task stays with its kept lead
    expect(partial.notRestored).toHaveLength(4);
    const mid = await state();
    expect(mid.props.find(p => p.id === melB).assigned_user_id).toBe(mel);          // untouched lead restored
    expect(mid.props.find(p => p.id === mariaA).assigned_user_id).toBe(jarrad);     // blocked: kept
    expect(mid.props.find(p => p.id === melA).assigned_user_id).toBe(jarrad);       // intent: kept
    expect(mid.tasks.find(t => t.id === melFollow)).toMatchObject({ assignee_id: jarrad, title: 'user edit' }); // edit preserved
    expect(mid.tasks.find(t => t.id === mariaCustom).assignee_id).toBe(jarrad);     // stays with its kept lead
    expect((await db.query('select count(*)::int n from public.acquisition_assignment_episodes where property_id=$1', [mariaA])).rows[0].n).toBe(2);
    expect((await db.query('select status from public.my_leads_housekeeping_runs where id=$1', [runB])).rows[0].status).toBe('applied');
    // Clearing the blockers lets a re-run finish the leads; the user's edit is still never overwritten.
    await db.query('delete from public.acquisition_attempts where property_id=$1', [mariaA]);
    await db.query("set local session_replication_role='replica'"); // intents are immutable evidence; test cleanup only
    await db.query('delete from public.dialpad_call_intents where property_id=$1', [melA]);
    await db.query("set local session_replication_role='origin'");
    const finish = await rollback(runB);
    expect(finish.notRestored).toEqual([expect.objectContaining({ task: melFollow, reason: 'EDITED_SINCE' })]);
    const end = await state();
    expect(end.props).toEqual(before.props);
    expect(end.tasks.find(t => t.id === melFollow)).toMatchObject({ assignee_id: jarrad, title: 'user edit' });

    // keep-clock variant leaves the new episode eligible.
    const keep = await applyNow(true);
    await finalizeLedger();
    expect(keep.leadsMoved).toBe(3);
    expect((await db.query("select eligible from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null", [mariaA])).rows[0].eligible).toBe(true);
    // Rollback blockers: a task created on the lead after the run, and an outbound message sent after it.
    const lateTask = await task('custom', jarrad, melB); // now() is the transaction start in this test, so stamp it after the run
    await db.query("update public.tasks set created_at=clock_timestamp() where id=$1", [lateTask]);
    await db.query("insert into public.messages(org_id,channel,direction,property_id,body,status,created_at) values ($1,'sms','outbound',$2,'hi','sent',clock_timestamp())", [org, melA]);
    const blockers = await rollback(keep.runId);
    const why = Object.fromEntries((blockers.notRestored as Array<Record<string, string>>).filter(n => n.property).map(n => [n.property, n.reason]));
    expect(why[melB]).toMatch(/WORK_RECORDED: task_created/);
    expect(why[melA]).toMatch(/WORK_RECORDED: outbound_message_sent/);
    expect((await state()).props.find(p => p.id === mariaA).assigned_user_id).toBe(maria); // unblocked lead restored

    // (f) access control and input checks.
    await expectError(() => as('anon', () => db.query('select public.fn_my_leads_housekeeping_reassign($1,$2,$3)', [org, jarrad, jarrad])), /permission denied/);
    await expectError(() => as('authenticated', () => db.query('select public.fn_my_leads_housekeeping_reassign($1,$2,$3)', [org, jarrad, jarrad])), /permission denied/);
    await expectError(() => as('authenticated', () => db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3)', [run, org, 'x'])), /permission denied/);
    await expectError(() => as('authenticated', () => db.query('select public.fn_my_leads_housekeeping_run_info($1,$2)', [run, org])), /permission denied/);
    await expectError(() => as('authenticated', () => db.query('select public.my_leads_housekeeping_require_service()')), /permission denied/);
    await expectError(() => as('authenticated', () => db.query('select * from public.my_leads_housekeeping_runs')), /permission denied/);
    await expectError(() => as('service_role', () => db.query('select * from public.my_leads_housekeeping_before_images')), /permission denied/);
    await expectError(() => as('service_role', () => db.query('select public.my_leads_housekeeping_reassign_scope($1,$2,now())', [org, jarrad])), /permission denied/);
    await expectError(() => as('service_role', () => db.query('select public.fn_my_leads_housekeeping_reassign($1,$2,$3)', [org, randomUUID(), jarrad])), /INVALID_TARGET/);
    await expectError(() => as('service_role', () => db.query('select public.fn_my_leads_housekeeping_reassign($1,$2,$3)', [org, jarrad, maria])), /INVALID_OWNER/);
    // service role is the only caller the gate admits, even for a definer-owned call.
    await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
    await expectError(() => db.query('select public.my_leads_housekeeping_require_service()'), /service role required/);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
});
