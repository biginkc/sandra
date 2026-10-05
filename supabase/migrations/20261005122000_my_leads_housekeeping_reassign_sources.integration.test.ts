import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { applyMyLeadsChain, stripTransaction } from '@tests/integration/my-leads-housekeeping-fixture';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

it('reassigns exactly the named source members (suspended and acquisitions-off included), never an unnamed active rep', async () => {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await applyMyLeadsChain(db, ['tools', 'reassign', 'outcome', 'schema', 'relabel', 'reassignSources']);

    const org = randomUUID(), jarrad = randomUUID(), maria = randomUUID(), mel = randomUUID(), gretchen = randomUUID();
    for (const id of [jarrad, maria, mel, gretchen]) await db.query('insert into auth.users(id) values ($1)', [id]);
    await db.query("insert into public.organizations(id,name) values ($1,'Sources')", [org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [jarrad, org]);
    for (const id of [maria, mel, gretchen]) await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [id, org]);
    await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [jarrad]);
    for (const id of [jarrad, maria, gretchen]) {
      await db.query("select set_config('my_leads.designation_update',$1,true)", [`${jarrad}:${org}:${id}`]);
      await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [id, org]);
    }
    await db.query("select set_config('my_leads.designation_update','',true)");
    const prop = async (key: string, assignee: string, status = 'new_lead') => {
      const id = randomUUID();
      await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,$3,'MO',$4,$5)", [id, org, `${key} Main`, status, assignee]);
      return id;
    };
    // Leads are created while everyone is active, then Maria is suspended and Mel stays acquisitions-off.
    const mariaA = await prop('mariaA', maria);
    const melA = await prop('melA', mel);
    const melB = await prop('melB', mel);
    const melClosed = await prop('melClosed', mel, 'closed');
    const gretchenA = await prop('gretchenA', gretchen);
    const jarradOwn = await prop('jarradOwn', jarrad);
    const task = async (assignee: string, property: string) => {
      const id = randomUUID();
      await db.query("insert into public.tasks(id,org_id,type,status,title,due_at,assignee_id,created_by,related_property_id) values ($1,$2,'custom','open','T',$3,$4,$5,$6)",
        [id, org, new Date(Date.now() + 86_400_000).toISOString(), assignee, jarrad, property]);
      return id;
    };
    const mariaTask = await task(maria, mariaA);
    const melTask = await task(mel, melA);
    const gretchenTask = await task(gretchen, gretchenA);
    await db.query("update public.memberships set access_status='suspended' where user_id=$1 and org_id=$2", [maria, org]);
    expect((await db.query('select access_status, acquisitions_enabled from public.memberships where user_id=$1 and org_id=$2', [mel, org])).rows[0])
      .toEqual({ access_status: 'active', acquisitions_enabled: false });

    const as = async <T>(role: 'authenticated' | 'anon' | 'service_role', fn: () => Promise<T>) => {
      await db.query(`set local role ${role}`);
      await db.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
      try { return await fn(); } finally { await db.query('reset role').catch(() => {}); }
    };
    const expectError = async (run: () => Promise<unknown>, pattern: RegExp) => {
      await db.query('savepoint s');
      let failure: unknown = null;
      try { await run(); } catch (error) { failure = error; }
      await db.query('rollback to savepoint s');
      await db.query('reset role');
      expect(String((failure as Error)?.message)).toMatch(pattern);
    };
    const call = (sources: (string | null)[] | null, apply = false, fingerprint: string | null = null) => as('service_role', async () =>
      (await db.query('select public.fn_my_leads_housekeeping_reassign($1,$2,$3,$4,$5,false,$6) as r', [org, jarrad, sources, jarrad, apply, fingerprint])).rows[0].r);
    const info = (run: string) => as('service_role', async () => (await db.query('select public.fn_my_leads_housekeeping_run_info($1,$2) as r', [run, org])).rows[0].r);
    const rollback = async (run: string) => as('service_role', async () =>
      (await db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as r', [run, org, (await info(run)).fingerprint])).rows[0].r);
    const owners = async () => Object.fromEntries((await db.query('select id,assigned_user_id from public.properties where org_id=$1', [org])).rows.map((r) => [r.id, r.assigned_user_id]));
    const taskOwners = async () => Object.fromEntries((await db.query('select id,assignee_id from public.tasks where org_id=$1', [org])).rows.map((r) => [r.id, r.assignee_id]));
    const before = { props: await owners(), tasks: await taskOwners() };

    // Scope: the suspended source and the acquisitions-off source are in; the unnamed active rep is not.
    const preview = await call([maria, mel]);
    expect(preview.leadCount).toBe(3);
    expect(preview.leads).toEqual(expect.arrayContaining([{ from: maria, count: 1 }, { from: mel, count: 2 }]));
    expect(preview.leads).toHaveLength(2);
    expect(preview.sources.sort()).toEqual([maria, mel].sort());
    expect(preview.tasks).toMatchObject({ nonAppointment: 2, appointments: 0 });
    expect(await call([mel, maria])).toEqual(preview); // order-insensitive and deterministic
    expect((await call([mel])).leadCount).toBe(2);
    expect((await call([gretchen])).leadCount).toBe(1); // only because it was named
    expect((await call([maria, mel])).fingerprint).toBe(preview.fingerprint);
    expect((await call([mel])).fingerprint).not.toBe(preview.fingerprint);
    expect((await call([maria])).fingerprint).not.toBe((await call([mel])).fingerprint);
    expect({ props: await owners(), tasks: await taskOwners() }).toEqual(before);

    // A fingerprint is bound to its sources.
    await expectError(() => call([mel], true, preview.fingerprint), /FINGERPRINT_MISMATCH/);

    // Input validation and the removed old signatures.
    await expectError(() => call(null), /INVALID_SOURCES/);
    await expectError(() => call([]), /INVALID_SOURCES/);
    await expectError(() => call([jarrad, mel]), /INVALID_SOURCES/);
    await expectError(() => call([mel, null]), /INVALID_SOURCES/);
    await expectError(() => as('service_role', () => db.query('select public.fn_my_leads_housekeeping_reassign($1,$2,$3)', [org, jarrad, jarrad])), /does not exist|malformed array/); // a lone uuid is never a valid sources list
    await expectError(() => as('service_role', () => db.query('select public.fn_my_leads_housekeeping_reassign($1::uuid,$2::uuid,$3::uuid,$4::boolean,$5::boolean,$6::text)', [org, jarrad, jarrad, false, false, null])), /does not exist/);
    await expectError(() => as('authenticated', () => db.query('select public.fn_my_leads_housekeeping_reassign($1,$2,$3,$4)', [org, jarrad, [mel], jarrad])), /permission denied/);
    await expectError(() => as('service_role', () => db.query('select public.my_leads_housekeeping_reassign_scope($1,$2,$3,now())', [org, jarrad, [mel]])), /permission denied/);

    // Apply: only Maria's and Mel's queue leads (and their open tasks) move.
    const applied = await call([maria, mel], true, preview.fingerprint);
    expect(applied).toMatchObject({ leadsMoved: 3, tasksMoved: 2, skipped: [] });
    const after = { props: await owners(), tasks: await taskOwners() };
    expect(after.props[mariaA]).toBe(jarrad);
    expect(after.props[melA]).toBe(jarrad);
    expect(after.props[melB]).toBe(jarrad);
    expect(after.props[melClosed]).toBe(mel);
    expect(after.props[gretchenA]).toBe(gretchen);
    expect(after.props[jarradOwn]).toBe(jarrad);
    expect(after.tasks[mariaTask]).toBe(jarrad);
    expect(after.tasks[melTask]).toBe(jarrad);
    expect(after.tasks[gretchenTask]).toBe(gretchen);
    expect((await db.query('select eligible from public.acquisition_assignment_episodes where org_id=$1 and ended_at is null and assignee_user_id=$2 and property_id=any($3)', [org, jarrad, [mariaA, melA, melB]])).rows)
      .toEqual([{ eligible: false }, { eligible: false }, { eligible: false }]);
    const run = applied.runId as string;
    expect((await info(run)).run.params.sources.sort()).toEqual([maria, mel].sort());

    // Rollback reads only the ledger. A suspended Maria cannot be an assignee again (the active-assignee
    // guard), so her lead is reported and left; everything else is restored, and a rerun finishes the job.
    const first = await rollback(run);
    expect(first.notRestored).toEqual(expect.arrayContaining([expect.objectContaining({ property: mariaA })]));
    const mid = { props: await owners(), tasks: await taskOwners() };
    expect(mid.props[melA]).toBe(mel);
    expect(mid.props[melB]).toBe(mel);
    expect(mid.props[gretchenA]).toBe(gretchen);
    expect(mid.props[mariaA]).toBe(jarrad);
    await db.query("update public.memberships set access_status='active' where user_id=$1 and org_id=$2", [maria, org]);
    const second = await rollback(run);
    expect(second).toMatchObject({ status: 'rolled_back', notRestored: [] });
    expect({ props: await owners(), tasks: await taskOwners() }).toEqual(before);
  } finally {
    await db.query('rollback').catch(() => {});
    await db.end();
  }
});

it('rolls back a run made by the old signature after this migration, and its rollback twin restores the old functions', async () => {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await applyMyLeadsChain(db, ['tools', 'reassign', 'outcome', 'schema', 'relabel']);
    const org = randomUUID(), jarrad = randomUUID(), mel = randomUUID();
    for (const id of [jarrad, mel]) await db.query('insert into auth.users(id) values ($1)', [id]);
    await db.query("insert into public.organizations(id,name) values ($1,'Compat')", [org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [jarrad, org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [mel, org]);
    await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [jarrad]);
    for (const id of [jarrad, mel]) {
      await db.query("select set_config('my_leads.designation_update',$1,true)", [`${jarrad}:${org}:${id}`]);
      await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [id, org]);
    }
    await db.query("select set_config('my_leads.designation_update','',true)");
    const lead = randomUUID();
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,'Old Main','MO','new_lead',$3)", [lead, org, mel]);
    const svc = async (sql: string, args: unknown[]) => {
      await db.query('set local role service_role');
      await db.query("select set_config('request.jwt.claim.role','service_role',true)");
      try { return (await db.query(sql, args)).rows[0].r; } finally { await db.query('reset role'); }
    };
    const oldPreview = await svc('select public.fn_my_leads_housekeeping_reassign($1,$2,$3) as r', [org, jarrad, jarrad]);
    const oldRun = await svc('select public.fn_my_leads_housekeeping_reassign($1,$2,$3,true,false,$4) as r', [org, jarrad, jarrad, oldPreview.fingerprint]);
    expect(oldRun.leadsMoved).toBe(1);

    // Apply the sources migration on top, then roll the old run back.
    await db.query(stripTransaction('migrations/20261005122000_my_leads_housekeeping_reassign_sources.sql'));
    const info = await svc('select public.fn_my_leads_housekeeping_run_info($1,$2) as r', [oldRun.runId, org]);
    const rolled = await svc('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as r', [oldRun.runId, org, info.fingerprint]);
    expect(rolled).toMatchObject({ status: 'rolled_back', restored: 1, notRestored: [] });
    expect((await db.query('select assigned_user_id from public.properties where id=$1', [lead])).rows[0].assigned_user_id).toBe(mel);

    // The rollback twin restores the old 6-argument function and drops the new one.
    await db.query(stripTransaction('rollbacks/20261005122000_my_leads_housekeeping_reassign_sources.sql'));
    const sigs = (await db.query("select pronargs from pg_proc where pronamespace='public'::regnamespace and proname='fn_my_leads_housekeeping_reassign'")).rows;
    expect(sigs).toEqual([{ pronargs: 6 }]);
  } finally {
    await db.query('rollback').catch(() => {});
    await db.end();
  }
});
