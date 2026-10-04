import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { applyMyLeadsChain, stripTransaction } from '@tests/integration/my-leads-housekeeping-fixture';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

async function open() {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  await db.query('begin');
  return db;
}

const svc = async <T>(db: Client, fn: () => Promise<T>) => {
  await db.query('set local role service_role');
  await db.query("select set_config('request.jwt.claim.role','service_role',true)");
  try { return await fn(); } finally { await db.query('reset role').catch(() => {}); }
};

it('scopes the reassign to the queue-state rows of the named sources (production shapes)', async () => {
  const db = await open();
  try {
    await applyMyLeadsChain(db, ['tools', 'reassign', 'outcome', 'schema', 'relabel', 'reassignSources', 'reassignQueueScope']);
    const org = randomUUID(), jarrad = randomUUID(), a = randomUUID(), b = randomUUID(), gretchen = randomUUID();
    for (const id of [jarrad, a, b, gretchen]) await db.query('insert into auth.users(id) values ($1)', [id]);
    await db.query("insert into public.organizations(id,name) values ($1,'QueueScope')", [org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [jarrad, org]);
    for (const id of [a, b, gretchen]) await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [id, org]);
    await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [jarrad]);
    // B and Gretchen are designated while the leads are created; A (Mel) is never acquisitions-enabled.
    for (const id of [jarrad, b, gretchen]) {
      await db.query("select set_config('my_leads.designation_update',$1,true)", [`${jarrad}:${org}:${id}`]);
      await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [id, org]);
    }
    await db.query("select set_config('my_leads.designation_update','',true)");

    const prop = async (key: string, assignee: string, status = 'new_lead') => {
      const id = randomUUID();
      await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,$3,'MO',$4,$5)", [id, org, `${key} Main`, status, assignee]);
      return id;
    };
    const queue = (id: string, stage = 'contacted') => db.query("insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at) values ($1,$2,$3,now()) on conflict do nothing", [id, org, stage]);
    // A (active, acquisitions-off): 1 queue-state lead + 5 non-queue properties. Observer episodes are
    // present only for enabled members, so A's leads have none; the queue row is the only signal.
    const aLead = await prop('aLead', a);
    await queue(aLead);
    const aOthers: string[] = [];
    for (let i = 0; i < 5; i++) aOthers.push(await prop(`aOther${i}`, a));
    // B (suspended later): two queue-state leads, then no open episode (ended manually below).
    const b1 = await prop('b1', b, 'contacted');
    const b2 = await prop('b2', b, 'interested');
    await queue(b1); await queue(b2, 'needs_offer');
    const gLead = await prop('gLead', gretchen);
    await queue(gLead);
    const own = await prop('jarradOwn', jarrad);
    await queue(own);
    const aDeleted = await prop('aDeleted', a);
    await queue(aDeleted);
    await db.query('update public.properties set deleted_at=now() where id=$1', [aDeleted]);
    const aArchived = await prop('aArchived', a);
    await queue(aArchived);
    await db.query("update public.acquisition_queue_states set archived_at=now(), archived_by=$2, archive_reason='manual' where property_id=$1", [aArchived, jarrad]);
    const aDnc = await prop('aDnc', a);
    await queue(aDnc);
    await db.query('update public.properties set is_dnc_locked=true where id=$1', [aDnc]);

    const task = async (assignee: string, property: string) => {
      const id = randomUUID();
      await db.query("insert into public.tasks(id,org_id,type,status,title,due_at,assignee_id,created_by,related_property_id) values ($1,$2,'custom','open','T',$3,$4,$5,$6)",
        [id, org, new Date(Date.now() + 86_400_000).toISOString(), assignee, jarrad, property]);
      return id;
    };
    const aTask = await task(a, aLead);
    const aOtherTask = await task(a, aOthers[0]); // non-queue lead: its task is not in scope
    const bTask = await task(b, b1);
    const gTask = await task(gretchen, gLead);

    await db.query("update public.memberships set access_status='suspended' where user_id=$1 and org_id=$2", [b, org]);
    await db.query('delete from public.acquisition_assignment_episodes where org_id=$1 and property_id=any($2)', [org, [b1, b2]]);
    expect((await db.query('select count(*)::int n from public.acquisition_assignment_episodes where org_id=$1 and ended_at is null and property_id=any($2)', [org, [b1, b2]])).rows[0].n).toBe(0);
    expect((await db.query('select access_status, acquisitions_enabled from public.memberships where user_id=$1 and org_id=$2', [a, org])).rows[0])
      .toEqual({ access_status: 'active', acquisitions_enabled: false });

    const call = (sources: string[], apply = false, fingerprint: string | null = null) => svc(db, async () =>
      (await db.query('select public.fn_my_leads_housekeeping_reassign($1,$2,$3,$4,$5,false,$6) as r', [org, jarrad, sources, jarrad, apply, fingerprint])).rows[0].r);
    const info = (run: string) => svc(db, async () => (await db.query('select public.fn_my_leads_housekeeping_run_info($1,$2) as r', [run, org])).rows[0].r);
    const rollback = async (run: string) => svc(db, async () =>
      (await db.query('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as r', [run, org, (await info(run)).fingerprint])).rows[0].r);
    const owners = async () => Object.fromEntries((await db.query('select id,assigned_user_id from public.properties where org_id=$1', [org])).rows.map((r) => [r.id, r.assigned_user_id]));
    const taskOwners = async () => Object.fromEntries((await db.query('select id,assignee_id from public.tasks where org_id=$1', [org])).rows.map((r) => [r.id, r.assignee_id]));
    const snapshot = { props: await owners(), tasks: await taskOwners() };

    // Preview: exactly the queue-state rows, per source.
    const previewA = await call([a]);
    expect(previewA.leadCount).toBe(1);
    expect(previewA.leads).toEqual([{ from: a, count: 1 }]);
    expect(previewA.tasks).toMatchObject({ nonAppointment: 1 });
    const previewB = await call([b]);
    expect(previewB.leadCount).toBe(2);
    const preview = await call([a, b]);
    expect(preview.leadCount).toBe(3);
    expect(preview.leads).toEqual(expect.arrayContaining([{ from: a, count: 1 }, { from: b, count: 2 }]));
    expect(preview.tasks).toMatchObject({ nonAppointment: 2, appointments: 0 });
    // Fingerprint depends on the sources.
    expect(previewA.fingerprint).not.toBe(preview.fingerprint);
    expect(previewA.fingerprint).not.toBe(previewB.fingerprint);
    expect((await call([b, a])).fingerprint).toBe(preview.fingerprint);
    expect({ props: await owners(), tasks: await taskOwners() }).toEqual(snapshot);
    await db.query('savepoint s');
    let failure: unknown = null;
    try { await call([a], true, preview.fingerprint); } catch (error) { failure = error; }
    await db.query('rollback to savepoint s');
    expect(String((failure as Error)?.message)).toMatch(/FINGERPRINT_MISMATCH/);

    // Apply moves only the queue-state leads; suspended B (no open episode) moves too.
    const applied = await call([a, b], true, preview.fingerprint);
    expect(applied).toMatchObject({ leadsMoved: 3, tasksMoved: 2, skipped: [] });
    const after = { props: await owners(), tasks: await taskOwners() };
    expect(after.props[aLead]).toBe(jarrad);
    expect(after.props[b1]).toBe(jarrad);
    expect(after.props[b2]).toBe(jarrad);
    for (const id of aOthers) expect(after.props[id]).toBe(a);
    expect(after.props[aDeleted]).toBe(a);
    expect(after.props[aArchived]).toBe(a);
    expect(after.props[aDnc]).toBe(a);
    expect(after.props[gLead]).toBe(gretchen);
    expect(after.props[own]).toBe(jarrad);
    expect(after.tasks[aTask]).toBe(jarrad);
    expect(after.tasks[bTask]).toBe(jarrad);
    expect(after.tasks[aOtherTask]).toBe(a);
    expect(after.tasks[gTask]).toBe(gretchen);
    expect((await db.query('select eligible from public.acquisition_assignment_episodes where org_id=$1 and ended_at is null and assignee_user_id=$2 and property_id=any($3)', [org, jarrad, [aLead, b1, b2]])).rows)
      .toEqual([{ eligible: false }, { eligible: false }, { eligible: false }]);

    // Rollback: A's lead restores; B is suspended so the active-assignee guard reports it.
    const run = applied.runId as string;
    const first = await rollback(run);
    expect(first.notRestored).toEqual(expect.arrayContaining([expect.objectContaining({ property: b1 })]));
    const mid = await owners();
    expect(mid[aLead]).toBe(a);
    expect(mid[b1]).toBe(jarrad);
    await db.query("update public.memberships set access_status='active' where user_id=$1 and org_id=$2", [b, org]);
    const second = await rollback(run);
    expect(second).toMatchObject({ status: 'rolled_back', notRestored: [] });
    expect({ props: await owners(), tasks: await taskOwners() }).toEqual(snapshot);
    // B had no open episode before the run and has none after the rollback.
    expect((await db.query('select count(*)::int n from public.acquisition_assignment_episodes where org_id=$1 and ended_at is null and property_id=any($2)', [org, [b1, b2]])).rows[0].n).toBe(0);
  } finally {
    await db.query('rollback').catch(() => {});
    await db.end();
  }
});

it('rolls back a run made by 122000 after this migration, and its rollback twin restores the 122000 bodies', async () => {
  const db = await open();
  try {
    await applyMyLeadsChain(db, ['tools', 'reassign', 'outcome', 'schema', 'relabel', 'reassignSources']);
    const org = randomUUID(), jarrad = randomUUID(), mel = randomUUID();
    for (const id of [jarrad, mel]) await db.query('insert into auth.users(id) values ($1)', [id]);
    await db.query("insert into public.organizations(id,name) values ($1,'Compat2')", [org]);
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
    const run = (sql: string, args: unknown[]) => svc(db, async () => (await db.query(sql, args)).rows[0].r);
    const p = await run('select public.fn_my_leads_housekeeping_reassign($1,$2,$3,$4) as r', [org, jarrad, [mel], jarrad]);
    const old = await run('select public.fn_my_leads_housekeeping_reassign($1,$2,$3,$4,true,false,$5) as r', [org, jarrad, [mel], jarrad, p.fingerprint]);
    expect(old.leadsMoved).toBe(1);

    const bodies = async () => (await db.query("select proname, prosrc from pg_proc where pronamespace='public'::regnamespace and proname in ('fn_my_leads_housekeeping_reassign','my_leads_housekeeping_reassign_scope','my_leads_housekeeping_reassign_fingerprint','my_leads_housekeeping_reassign_task_ids') order by 1")).rows;
    const bodies122 = await bodies();
    await db.query(stripTransaction('migrations/20261005190000_my_leads_housekeeping_reassign_queue_scope.sql'));
    const info = await run('select public.fn_my_leads_housekeeping_run_info($1,$2) as r', [old.runId, org]);
    const rolled = await run('select public.fn_my_leads_housekeeping_rollback($1,$2,$3) as r', [old.runId, org, info.fingerprint]);
    expect(rolled).toMatchObject({ status: 'rolled_back', restored: 1, notRestored: [] });
    expect((await db.query('select assigned_user_id from public.properties where id=$1', [lead])).rows[0].assigned_user_id).toBe(mel);
    expect(await bodies()).not.toEqual(bodies122);

    await db.query(stripTransaction('rollbacks/20261005190000_my_leads_housekeeping_reassign_queue_scope.sql'));
    expect(await bodies()).toEqual(bodies122);
  } finally {
    await db.query('rollback').catch(() => {});
    await db.end();
  }
});
