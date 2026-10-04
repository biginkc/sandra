import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';
import { applyMyLeadsChain, MIGRATIONS, stripTransaction } from '@tests/integration/my-leads-housekeeping-fixture';

const strip = (file: string) => {
  const sql = readFileSync(new URL(file, import.meta.url), 'utf8');
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error(`${file}: transaction wrapper changed`);
  return sql.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
};
const reassign = stripTransaction(MIGRATIONS.reassign);
const rollbackFile = strip('../rollbacks/20261005121500_next_step_relabel_functions.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const DAY = 86_400_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function withDb(files: string[], fn: (db: Client) => Promise<void>) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await applyMyLeadsChain(db, ['tools', 'reassign', 'outcome', 'schema', 'relabel']);
    for (const file of files) await db.query(file);
    await fn(db);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

const helpers = (db: Client) => {
  const as = async <T>(role: 'authenticated' | 'anon' | 'service_role', run: () => Promise<T>) => {
    await db.query(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
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
  return { as, expectError };
};

async function seedOrg(db: Client) {
  const org = randomUUID(), jarrad = randomUUID(), maria = randomUUID();
  for (const id of [jarrad, maria]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1,'Relabel')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [jarrad, org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [maria, org]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [jarrad]);
  for (const id of [jarrad, maria]) {
    await db.query("select set_config('my_leads.designation_update',$1,true)", [`${jarrad}:${org}:${id}`]);
    await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [id, org]);
  }
  await db.query("select set_config('my_leads.designation_update','',true)");
  const prop = async (key: string, assignee: string | null = null) => {
    const id = randomUUID();
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,$3,'MO','new_lead',$4)", [id, org, `${key} Main`, assignee]);
    return id;
  };
  return { org, jarrad, maria, prop };
}

async function seedLegacy(db: Client, ctx: Awaited<ReturnType<typeof seedOrg>>) {
  const { org, jarrad, prop } = ctx;
  const task = async (type: string, property: string, over: { status?: string; due?: number; snoozed?: number; contact?: string; key?: string; assignee?: string } = {}) => {
    const id = randomUUID();
    await db.query(
      `insert into public.tasks(id,org_id,type,status,title,due_at,snoozed_until,assignee_id,created_by,related_property_id,contact_id,lead_next_action_idempotency_key)
       values ($1,$2,$3,$4,'Legacy',$5,$6,$7,$8,$9,$10,$11)`,
      [id, org, type, over.status ?? 'open', new Date(Date.now() + (over.due ?? 2 * DAY)).toISOString(),
        over.snoozed === undefined ? null : new Date(Date.now() + over.snoozed).toISOString(),
        over.assignee ?? jarrad, jarrad, property, over.contact ?? null, over.key ?? null]);
    return id;
  };
  const p = { cb: await prop('cb'), fu: await prop('fu'), sn: await prop('sn'), done: await prop('done'), past: await prop('past'), dnc: await prop('dnc'), locked: await prop('locked') };
  const leadKey = randomUUID();
  const ids = {
    cb: await task('callback', p.cb),
    fu: await task('follow_up', p.fu, { due: 3 * DAY, key: leadKey }),
    sn: await task('callback', p.sn, { status: 'snoozed', due: -DAY, snoozed: 4 * DAY }),
    done: await task('callback', p.done, { status: 'completed' }),
    past: await task('callback', p.past, { due: -2 * DAY }),
    dnc: '',
    locked: await task('follow_up', p.locked),
    leadKey,
  };
  const contact = randomUUID();
  await db.query("insert into public.contacts(id,org_id,first_name,last_name) values ($1,$2,'Dee','Enn')", [contact, org]);
  ids.dnc = await task('callback', p.dnc, { contact });
  await db.query("set local session_replication_role='replica'");
  await db.query('update public.contacts set do_not_contact=true where id=$1', [contact]);
  await db.query('update public.properties set is_dnc_locked=true where id=$1', [p.locked]);
  await db.query("set local session_replication_role='origin'");
  return { ids, p };
}

it('relabels open future next steps behind a fingerprint, leaves history alone, and rolls back exactly', async () => {
  await withDb([], async (db) => {
    const { as, expectError } = helpers(db);
    const ctx = await seedOrg(db);
    const { org, jarrad, maria } = ctx;
    const { ids } = await seedLegacy(db, ctx);

    let cut: string | null = null;
    const call = (apply: boolean, fingerprint: string | null = null, expected = jarrad, cutoff: string | null = cut) => as('service_role', async () =>
      (await db.query('select public.fn_my_leads_relabel_open_next_steps($1,$2,$3,$4,$5) as r', [org, expected, apply, fingerprint, cutoff])).rows[0].r);
    const info = (run: string) => as('service_role', async () => (await db.query('select public.fn_my_leads_housekeeping_run_info($1,$2) as r', [run, org])).rows[0].r);
    const rollback = async (run: string) => as('service_role', async () =>
      (await db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as r', [run, org, (await info(run)).fingerprint])).rows[0].r);
    const previewNow = async (expected = jarrad) => { cut = null; const p = await call(false, null, expected); cut = p.cutoff; return p; };
    const tasks = async () => (await db.query('select id,type,status,mode,due_at,end_at,snoozed_until,calendar_chain_id,updated_at,lead_next_action_idempotency_key k from public.tasks where org_id=$1 order by id', [org])).rows;
    const attributions = async () => (await db.query('select task_id,source,accountable_user_id from public.acquisition_appointment_attribution where org_id=$1 order by task_id', [org])).rows;
    const kpis = () => as('authenticated', async () => {
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [jarrad]);
      const v = (await db.query("select public.fn_get_acquisition_kpis($1,$2,now()-interval '30 days',now()) as v", [org, jarrad])).rows[0].v;
      delete v.asOf;
      return v;
    });
    const runs = async () => (await db.query('select count(*)::int n from public.my_leads_housekeeping_runs')).rows[0].n;
    const flag = async () => (await db.query("select coalesce(current_setting('sandra.allow_appointment_time_move',true),'') as f")).rows[0].f;

    const stateBefore = await tasks();
    const attrBefore = await attributions();
    const kpiBefore = await kpis();

    // Preview: counts, no writes, and the cutoff it used is returned.
    const preview = await previewNow();
    expect(preview).toMatchObject({
      kind: 'relabel', candidates: 4, snoozedToOpen: 1, skippedLocked: 1, assigneeMismatch: 0,
      byType: { callback: 3, follow_up: 1 }, byAssignee: [{ assignee: jarrad, count: 4 }],
    });
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await call(false)).toEqual(preview);
    expect(await tasks()).toEqual(stateBefore);
    expect(await runs()).toBe(0);

    // Apply is fenced.
    await expectError(() => call(true), /FINGERPRINT_REQUIRED/);
    await expectError(() => call(true, 'a'.repeat(64)), /FINGERPRINT_MISMATCH/);
    await expectError(() => call(true, preview.fingerprint, jarrad, null), /CUTOFF_REQUIRED/);
    await expectError(() => call(true, preview.fingerprint, jarrad, new Date(Date.now() - 3 * DAY).toISOString()), /INVALID_INPUT/);
    // Substituted candidate: same count, different rows.
    await db.query('savepoint sub');
    await db.query("update public.tasks set status='completed', completed_at=now() where id=$1", [ids.cb]);
    const extra = await ctx.prop('extra');
    await db.query(
      "insert into public.tasks(org_id,type,status,title,due_at,assignee_id,created_by,related_property_id) values ($1,'callback','open','Sub',now()+interval '5 days',$2,$2,$3)",
      [org, jarrad, extra]);
    expect((await call(false)).candidates).toBe(4);
    await expectError(() => call(true, preview.fingerprint), /FINGERPRINT_MISMATCH/);
    await db.query('rollback to savepoint sub');
    // Edited candidate: same ids, same counts.
    await db.query('savepoint sub');
    await db.query("update public.tasks set title='edited', updated_at=clock_timestamp() where id=$1", [ids.fu]);
    await expectError(() => call(true, preview.fingerprint), /FINGERPRINT_MISMATCH/);
    await db.query('rollback to savepoint sub');
    expect(await tasks()).toEqual(stateBefore);
    // ASSIGNEE_MISMATCH: the preview reports it, the apply refuses.
    const wrong = await previewNow(maria);
    expect(wrong.assigneeMismatch).toBe(4);
    await expectError(() => call(true, wrong.fingerprint, maria), /ASSIGNEE_MISMATCH: 4 rows/);
    expect(await runs()).toBe(0);

    // Apply.
    const fresh = await previewNow();
    const applied = await call(true, fresh.fingerprint);
    expect(applied).toMatchObject({ converted: 3 });
    expect(applied.skipped).toHaveLength(1);
    expect(applied.skipped[0]).toMatchObject({ task: ids.dnc });
    expect(await flag()).toBe('');
    const run = applied.runId as string;
    const after = await tasks();
    const byId = (rows: Array<Record<string, Json>>, id: string) => rows.find(r => r.id === id)!;
    for (const id of [ids.cb, ids.fu, ids.sn]) {
      const t = byId(after, id);
      expect(t).toMatchObject({ type: 'appointment', mode: 'phone', status: 'open', snoozed_until: null });
      expect(t.calendar_chain_id).toBeTruthy();
      expect(new Date(t.end_at).getTime() - new Date(t.due_at).getTime()).toBe(15 * 60_000);
    }
    expect(byId(after, ids.fu).k).toBe(ids.leadKey); // a relabeled follow-up keeps its lead-next-action key
    // A snoozed row becomes open at its snoozed time.
    const snBefore = byId(stateBefore, ids.sn);
    expect(new Date(byId(after, ids.sn).due_at).getTime()).toBe(new Date(snBefore.snoozed_until).getTime());
    // History, DNC-contact, DNC-locked property rows are untouched.
    for (const id of [ids.done, ids.past, ids.dnc, ids.locked]) expect(byId(after, id)).toEqual(byId(stateBefore, id));
    // Attribution rows for exactly the converted tasks; no calendar ledger rows.
    const attr = await attributions();
    expect(attr.map(a => a.task_id).sort()).toEqual([ids.cb, ids.fu, ids.sn].sort());
    expect(attr.every(a => a.source === 'relabel_2026_10' && a.accountable_user_id === jarrad)).toBe(true);
    expect((await db.query('select count(*)::int n from public.task_calendar_mutations where org_id=$1', [org])).rows[0].n).toBe(0);
    const images = await db.query("select table_name,before->>'op' as op,count(*)::int n from public.my_leads_housekeeping_before_images where run_id=$1 group by 1,2 order by 1,2", [run]);
    expect(images.rows).toEqual([
      { table_name: 'acquisition_appointment_attribution', op: 'created', n: 3 },
      { table_name: 'tasks', op: 'updated', n: 3 },
    ]);
    // KPI window entirely in the past is identical before and after.
    expect(await kpis()).toEqual(kpiBefore);

    // Second apply is a no-op.
    const again = await previewNow();
    expect(again.candidates).toBe(1); // only the DNC-contact row is still a candidate
    expect(await call(true, again.fingerprint)).toMatchObject({ converted: 0 });
    expect(await runs()).toBe(2);
    // Un-DNC the contact would convert it; instead make it non-candidate to prove the no-op path.
    await db.query("set local session_replication_role='replica'");
    await db.query("update public.tasks set status='cancelled' where id=$1", [ids.dnc]);
    await db.query("set local session_replication_role='origin'");
    const empty = await previewNow();
    expect(empty.candidates).toBe(0);
    expect(await call(true, empty.fingerprint)).toMatchObject({ noop: true, runId: null });
    expect(await runs()).toBe(2);
    await db.query("set local session_replication_role='replica'");
    await db.query("update public.tasks set status='open' where id=$1", [ids.dnc]);
    await db.query("set local session_replication_role='origin'");
    await db.query("delete from public.my_leads_housekeeping_runs where id <> $1", [run]);

    // Rollback restores type/chain/end_at and removes the attribution rows.
    await expectError(() => as('service_role', () => db.query('select public.fn_my_leads_housekeeping_rollback($1,$2)', [run, org])), /FINGERPRINT_REQUIRED/);
    await expectError(() => as('service_role', () => db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3)', [run, org, 'x'])), /FINGERPRINT_MISMATCH/);
    const rolled = await rollback(run);
    expect(rolled).toMatchObject({ status: 'rolled_back', restored: 3, notRestored: [] });
    expect(await flag()).toBe('');
    const restored = await tasks();
    for (const id of [ids.cb, ids.fu, ids.sn, ids.done, ids.past, ids.dnc, ids.locked]) expect(byId(restored, id)).toEqual(byId(stateBefore, id));
    expect(await attributions()).toEqual(attrBefore);
    expect(await as('service_role', async () => (await db.query('select public.fn_my_leads_housekeeping_rollback($1,$2) as r', [run, org])).rows[0].r)).toMatchObject({ noop: true });
  });
});

it('relabel rollback skips rows that were completed, rescheduled, edited or have new work, and fences attribution changes', async () => {
  await withDb([], async (db) => {
    const { as, expectError } = helpers(db);
    const ctx = await seedOrg(db);
    const { org, jarrad } = ctx;
    const { ids, p } = await seedLegacy(db, ctx);
    const extraProp = await ctx.prop('extra2');
    const extraTask = randomUUID();
    await db.query(
      "insert into public.tasks(id,org_id,type,status,title,due_at,assignee_id,created_by,related_property_id) values ($1,$2,'callback','open','X',now()+interval '6 days',$3,$3,$4)",
      [extraTask, org, jarrad, extraProp]);
    const preview = (await as('service_role', async () => (await db.query('select public.fn_my_leads_relabel_open_next_steps($1,$2) as r', [org, jarrad])).rows[0].r));
    const applied = await as('service_role', async () => (await db.query('select public.fn_my_leads_relabel_open_next_steps($1,$2,true,$3,$4) as r', [org, jarrad, preview.fingerprint, preview.cutoff])).rows[0].r);
    expect(applied.converted).toBe(4);
    const run = applied.runId as string;
    const info = () => as('service_role', async () => (await db.query('select public.fn_my_leads_housekeeping_run_info($1,$2) as r', [run, org])).rows[0].r);
    const rollback = async () => as('service_role', async () =>
      (await db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as r', [run, org, (await info()).fingerprint])).rows[0].r);
    const lifecycle = async (sql: string, args: unknown[]) => {
      await db.query("select set_config('sandra.allow_appointment_time_move','on',true)");
      await db.query(sql, args);
      await db.query("select set_config('sandra.allow_appointment_time_move','',true)");
    };

    // fu: completed since the run. cb: rescheduled (closed with a successor in the chain).
    await lifecycle("update public.tasks set status='completed', outcome='held', completed_at=now(), completed_by=$2 where id=$1", [ids.fu, jarrad]);
    const cbChain = (await db.query('select calendar_chain_id c from public.tasks where id=$1', [ids.cb])).rows[0].c;
    await lifecycle("update public.tasks set status='completed', outcome='rescheduled', completed_at=now(), completed_by=$2 where id=$1", [ids.cb, jarrad]);
    await lifecycle(
      "insert into public.tasks(org_id,type,status,title,due_at,end_at,assignee_id,created_by,related_property_id,calendar_chain_id) values ($1,'appointment','open','Succ',now()+interval '9 days',now()+interval '9 days 15 minutes',$2,$2,$3,$4)",
      [org, jarrad, p.cb, cbChain]);
    // sn: new work since the run (a task created on the lead after the run).
    await db.query(
      "insert into public.tasks(org_id,type,status,title,due_at,assignee_id,created_by,related_property_id,created_at) values ($1,'custom','open','New',now()+interval '1 day',$2,$2,$3,clock_timestamp()+interval '1 second')",
      [org, jarrad, p.sn]);
    // extraTask: the attribution row was changed since.
    await db.query("update public.acquisition_appointment_attribution set accountable_user_id=$2 where task_id=$1", [extraTask, ctx.maria]);
    // locked: nothing relabeled (never a candidate); its row is not in the run.
    const partial = await rollback();
    expect(partial.status).toBe('applied');
    const reasons = Object.fromEntries((partial.notRestored as Array<Record<string, string>>).map(n => [n.task, n.reason]));
    expect(reasons[ids.fu]).toBe('NOT_OPEN_SINCE');
    expect(reasons[ids.cb]).toBe('NOT_OPEN_SINCE');
    expect(reasons[ids.sn]).toMatch(/WORK_RECORDED: task_created/);
    expect(reasons[extraTask]).toBe('ATTRIBUTION_CHANGED_SINCE');
    expect(partial.restored).toBe(0);
    expect((await db.query("select count(*)::int n from public.tasks where id=any($1) and type='appointment'", [[ids.fu, ids.cb, ids.sn, extraTask]])).rows[0].n).toBe(4);

    // Open rows with ledger activity or a mode change are skipped by their own reasons.
    await db.query("delete from public.tasks where org_id=$1 and title='New'", [org]);
    await lifecycle("update public.tasks set status='cancelled', outcome='cancelled' where org_id=$1 and title='Succ'", [org]);
    await db.query("update public.acquisition_appointment_attribution set accountable_user_id=$2 where task_id=$1", [extraTask, jarrad]);
    await lifecycle("update public.tasks set status='open', outcome=null, completed_at=null, completed_by=null where id in ($1,$2)", [ids.fu, ids.cb]);
    // cb: rescheduled in place (time moved); fu: a ledger row now exists for its chain.
    await lifecycle("update public.tasks set due_at=due_at+interval '1 hour', end_at=end_at+interval '1 hour' where id=$1", [ids.cb]);
    const fuRow = (await db.query('select calendar_chain_id c, assignee_id a from public.tasks where id=$1', [ids.fu])).rows[0];
    await db.query("insert into public.task_calendar_mutations(org_id,calendar_chain_id,operation,phase,source_task_id,old_assignee_id,expected_generation) values ($1,$2,'create','finalized',$3,$4,0)", [org, fuRow.c, ids.fu, fuRow.a]);
    const second = await rollback();
    const reasons2 = Object.fromEntries((second.notRestored as Array<Record<string, string>>).map(n => [n.task, n.reason]));
    expect(reasons2[ids.cb]).toBe('RESCHEDULED_SINCE');
    expect(reasons2[ids.fu]).toBe('CALENDAR_ACTIVITY_SINCE');
    expect(reasons2[ids.sn]).toBeUndefined();
    expect(second.restored).toBe(2); // sn and extraTask, no longer blocked
    expect((await db.query("select type from public.tasks where id=$1", [ids.sn])).rows[0].type).toBe('callback');
    expect((await db.query('select count(*)::int n from public.acquisition_appointment_attribution where task_id=any($1)', [[ids.sn, extraTask]])).rows[0].n).toBe(0);
    expect((await db.query('select status from public.my_leads_housekeeping_runs where id=$1', [run])).rows[0].status).toBe('applied');
    await expectError(() => as('service_role', () => db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3)', [run, org, 'stale'])), /FINGERPRINT_MISMATCH/);
  });
});

it('sets next-step mode with the calendar ledger, service role only', async () => {
  await withDb([], async (db) => {
    const { as, expectError } = helpers(db);
    const ctx = await seedOrg(db);
    const { org, jarrad } = ctx;
    const prop = await ctx.prop('mode');
    const appt = async (over: { mins?: number; status?: string; mode?: string; location?: string | null } = {}) => {
      const id = randomUUID();
      await db.query(
        `insert into public.tasks(id,org_id,type,status,title,due_at,end_at,assignee_id,created_by,related_property_id,calendar_chain_id,mode,location)
         values ($1,$2,'appointment','open','Appt',now()+interval '2 days',now()+interval '2 days'+($3||' minutes')::interval,$4,$4,$5,$6,$7,$8)`,
        [id, org, String(over.mins ?? 15), jarrad, prop, randomUUID(), over.mode ?? 'phone', over.location ?? null]);
      return id;
    };
    const setMode = (task: string, mode: string, location: string | null = null) => as('service_role', () =>
      db.query('select public.fn_set_next_step_mode($1,$2,$3)', [task, mode, location]));
    const row = async (id: string) => (await db.query('select mode,location,calendar_generation g,google_calendar_event_id e from public.tasks where id=$1', [id])).rows[0];
    const ledger = async (id: string) => (await db.query('select operation,phase,event_id,client_event_id,expected_generation g,old_assignee_id from public.task_calendar_mutations where source_task_id=$1 order by expected_generation, operation', [id])).rows;

    // phone -> in_person queues the create row exactly like booking.
    const a = await appt();
    await setMode(a, 'in_person', '  1 Main St  ');
    expect(await row(a)).toMatchObject({ mode: 'in_person', location: '1 Main St', g: 1 });
    const create = await ledger(a);
    expect(create).toHaveLength(1);
    expect(create[0]).toMatchObject({ operation: 'create', phase: 'pending', g: 1, old_assignee_id: jarrad });
    const expected = (await db.query('select public.fn_uuid_to_base32hex(id) as c from public.task_calendar_mutations where source_task_id=$1', [a])).rows[0].c;
    expect(create[0].client_event_id).toBe(expected);
    // Same call again: nothing changes. A pending sync blocks a mode change.
    await setMode(a, 'in_person', '1 Main St');
    expect(await ledger(a)).toHaveLength(1);
    await expectError(() => setMode(a, 'phone'), /calendar sync in progress/);
    // Location edit alone: no generation bump and no ledger row.
    await db.query("update public.task_calendar_mutations set phase='finalized' where source_task_id=$1", [a]);
    await db.query("select set_config('sandra.allow_appointment_time_move','on',true)");
    await db.query("update public.tasks set google_calendar_event_id='evt-1' where id=$1", [a]);
    await db.query("select set_config('sandra.allow_appointment_time_move','',true)");
    await setMode(a, 'in_person', '2 Oak St');
    expect(await row(a)).toMatchObject({ location: '2 Oak St', g: 1 });
    expect(await ledger(a)).toHaveLength(1);
    // in_person -> phone with an existing Google event queues a cancel carrying that event id.
    await setMode(a, 'phone');
    expect(await row(a)).toMatchObject({ mode: 'phone', location: null, g: 2 });
    const rows = await ledger(a);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ operation: 'cancel', phase: 'pending', event_id: 'evt-1', g: 2 });
    // in_person -> phone without an event: no ledger row, generation still bumps.
    const b = await appt({ mode: 'in_person', location: 'Cafe' });
    await setMode(b, 'phone');
    expect(await row(b)).toMatchObject({ mode: 'phone', location: null, g: 1 });
    expect(await ledger(b)).toHaveLength(0);
    // Input checks.
    const callback = (await db.query("insert into public.tasks(org_id,type,status,title,due_at,assignee_id,created_by,related_property_id) values ($1,'callback','open','T',now()+interval '1 day',$2,$2,$3) returning id", [org, jarrad, prop])).rows[0].id;
    await expectError(() => setMode(callback, 'in_person'), /NOT_AN_APPOINTMENT/);
    const closed = await appt();
    await db.query("select set_config('sandra.allow_appointment_time_move','on',true)");
    await db.query("update public.tasks set status='cancelled', outcome='cancelled' where id=$1", [closed]);
    await db.query("select set_config('sandra.allow_appointment_time_move','',true)");
    await expectError(() => setMode(closed, 'in_person'), /NOT_OPEN/);
    const c = await appt();
    await expectError(() => setMode(c, 'phone', 'Somewhere'), /INVALID_INPUT/);
    await expectError(() => setMode(c, 'in_person', 'x'.repeat(501)), /INVALID_INPUT/);
    await expectError(() => setMode(c, 'video'), /INVALID_INPUT/);
    await expectError(() => setMode(randomUUID(), 'phone'), /TASK_NOT_FOUND/);
    const short = await appt({ mins: 10 });
    await expectError(() => setMode(short, 'in_person'), /INVALID_INPUT: an in-person appointment lasts/);
    expect(await row(c)).toMatchObject({ mode: 'phone', g: 0 });
    // Access control.
    await expectError(() => as('anon', () => db.query('select public.fn_set_next_step_mode($1,$2)', [c, 'phone'])), /permission denied/);
    await expectError(() => as('authenticated', () => db.query('select public.fn_set_next_step_mode($1,$2)', [c, 'phone'])), /permission denied/);
  });
});

it('retire preflight counts the legacy set read-only; every new function is closed to anon and authenticated', async () => {
  await withDb([], async (db) => {
    const { as, expectError } = helpers(db);
    const ctx = await seedOrg(db);
    const { org, jarrad } = ctx;
    await seedLegacy(db, ctx);
    const preflight = () => as('service_role', async () => (await db.query('select public.fn_my_leads_next_step_retire_preflight($1) as r', [org])).rows[0].r);
    const snapshot = async () => (await db.query('select id,type,status,updated_at from public.tasks where org_id=$1 order by id', [org])).rows;
    const before = await snapshot();
    const got = await preflight();
    // cb, fu, sn (snoozed to +4d), dnc contact row and the locked-property row are open and future; past is past due.
    expect(got).toMatchObject({ openFutureLegacy: 5, openPastDueLegacy: 1, snoozedLegacy: 1 });
    expect(got.byAssignee).toEqual([{ assignee: jarrad, count: 6 }]);
    expect(await snapshot()).toEqual(before);
    expect((await db.query('select count(*)::int n from public.my_leads_housekeeping_runs')).rows[0].n).toBe(0);
    // Another org sees nothing.
    expect(await as('service_role', async () => (await db.query('select public.fn_my_leads_next_step_retire_preflight($1) as r', [randomUUID()])).rows[0].r))
      .toMatchObject({ openFutureLegacy: 0, openPastDueLegacy: 0, snoozedLegacy: 0, byAssignee: [] });

    const cutoff = new Date().toISOString();
    const calls: Array<[string, unknown[]]> = [
      ['select public.fn_my_leads_relabel_open_next_steps($1,$2)', [org, jarrad]],
      ['select public.fn_my_leads_relabel_open_next_steps($1,$2,false,null,$3)', [org, jarrad, cutoff]],
      ['select public.fn_set_next_step_mode($1,$2)', [randomUUID(), 'phone']],
      ['select public.fn_my_leads_next_step_retire_preflight($1)', [org]],
      ['select public.my_leads_relabel_candidate_ids($1,$2)', [org, cutoff]],
    ];
    for (const role of ['anon', 'authenticated'] as const) {
      for (const [sql, args] of calls) await expectError(() => as(role, () => db.query(sql, args)), /permission denied/);
    }
    await expectError(() => as('service_role', () => db.query('select public.my_leads_relabel_candidate_ids($1,$2)', [org, cutoff])), /permission denied/);
    // The service gate itself: a definer call with a non-service role claim is refused.
    await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
    await expectError(() => db.query('select public.fn_my_leads_next_step_retire_preflight($1)', [org]), /service role required/);
    await expectError(() => db.query('select public.fn_set_next_step_mode($1,$2)', [randomUUID(), 'phone']), /service role required/);
    await expectError(() => db.query('select public.fn_my_leads_relabel_open_next_steps($1,$2)', [org, jarrad]), /service role required/);
  });
});

it('keeps reassign and close_attempts rollbacks working through the replaced rollback functions', async () => {
  await withDb([], async (db) => {
    const { as } = helpers(db);
    const ctx = await seedOrg(db);
    const { org, jarrad, maria } = ctx;
    const mariaA = await ctx.prop('mariaA', maria);
    const task = (await db.query(
      "insert into public.tasks(org_id,type,status,title,due_at,assignee_id,created_by,related_property_id) values ($1,'custom','open','T',now()+interval '1 day',$2,$3,$4) returning id",
      [org, maria, jarrad, mariaA])).rows[0].id as string;
    const svc = <T>(sql: string, args: unknown[]) => as('service_role', async () => (await db.query(sql, args)).rows[0].r as T);
    const info = (run: string) => svc<Json>('select public.fn_my_leads_housekeeping_run_info($1,$2) as r', [run, org]);
    const rollback = async (run: string) => svc<Json>('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as r', [run, org, (await info(run)).fingerprint]);

    // reassign apply + rollback
    const rp = await svc<Json>('select public.fn_my_leads_housekeeping_reassign($1,$2,$3) as r', [org, jarrad, jarrad]);
    const ra = await svc<Json>('select public.fn_my_leads_housekeeping_reassign($1,$2,$3,true,false,$4) as r', [org, jarrad, jarrad, rp.fingerprint]);
    expect(ra).toMatchObject({ leadsMoved: 1, tasksMoved: 1 });
    expect((await db.query('select assigned_user_id a from public.properties where id=$1', [mariaA])).rows[0].a).toBe(jarrad);
    expect(await rollback(ra.runId)).toMatchObject({ status: 'rolled_back', restored: 2, notRestored: [] });
    expect((await db.query('select assigned_user_id a from public.properties where id=$1', [mariaA])).rows[0].a).toBe(maria);
    expect((await db.query('select assignee_id a from public.tasks where id=$1', [task])).rows[0].a).toBe(maria);

    // close_attempts apply + rollback
    const attempt = randomUUID();
    await db.query(
      "insert into public.acquisition_attempts(id,org_id,property_id,actor_user_id,attempt_kind,source,outcome,occurred_at,provider_attempt_key,idempotency_key) values ($1,$2,$3,$4,'call','sandra',null,now()-interval '30 days',$5,$6)",
      [attempt, org, mariaA, jarrad, `hk-${randomUUID()}`, randomUUID()]);
    const cp = await svc<Json>("select public.fn_my_leads_housekeeping_close_attempts($1,'7 days'::interval) as r", [org]);
    expect(cp.count).toBe(1);
    const ca = await svc<Json>("select public.fn_my_leads_housekeeping_close_attempts($1,'7 days'::interval,true,$2,$3) as r", [org, cp.fingerprint, cp.cutoff]);
    expect(ca.closed).toBe(1);
    expect((await db.query('select outcome o from public.acquisition_attempts where id=$1', [attempt])).rows[0].o).toBe('not_logged');
    expect(await rollback(ca.runId)).toMatchObject({ status: 'rolled_back', restored: 1, notRestored: [] });
    expect((await db.query('select outcome o from public.acquisition_attempts where id=$1', [attempt])).rows[0].o).toBeNull();
  });
});

it('the rollback twin restores the P1e rollback functions and drops the new ones', async () => {
  await withDb([rollbackFile], async (db) => {
    const exists = async (name: string) => (await db.query('select to_regproc($1) is not null as e', [name])).rows[0].e;
    expect(await exists('public.fn_my_leads_relabel_open_next_steps')).toBe(false);
    expect(await exists('public.fn_set_next_step_mode')).toBe(false);
    expect(await exists('public.fn_my_leads_next_step_retire_preflight')).toBe(false);
    expect(await exists('public.my_leads_relabel_candidate_ids')).toBe(false);
    const body = (await db.query("select pg_get_functiondef('public.fn_my_leads_housekeeping_rollback(uuid,uuid,text)'::regprocedure) as d")).rows[0].d as string;
    expect(body).not.toMatch(/relabel/);
    expect(body).toMatch(/close_attempts/);
    // Restored bodies are the 20261005100100 text verbatim.
    const original = await withBody(db);
    expect(body.replace(/\s+/g, ' ')).toBe(original.replace(/\s+/g, ' '));
  });
});

async function withBody(db: Client) {
  // Re-create the P1e rollback function in a throwaway schema-free way: read it back from a
  // fresh replay of the P1e file only, inside a savepoint that is rolled back.
  await db.query('savepoint p1e');
  await db.query(reassign);
  const d = (await db.query("select pg_get_functiondef('public.fn_my_leads_housekeeping_rollback(uuid,uuid,text)'::regprocedure) as d")).rows[0].d as string;
  await db.query('rollback to savepoint p1e');
  return d;
}
