import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';
import { applyMyLeadsChain, chainThrough } from '@tests/integration/my-leads-housekeeping-fixture';

const strip = (file: string) => {
  const sql = readFileSync(new URL(file, import.meta.url), 'utf8');
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error(`${file}: transaction wrapper changed`);
  return sql.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
};
const migration = strip('./20261008100000_retire_follow_up_callback_types.sql');
const rollbackFile = strip('../rollbacks/20261008100000_retire_follow_up_callback_types.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const DAY = 86_400_000;

// Everything below the retire entry, then the retire migration itself, in one rolled-back transaction.
async function withDb(fn: (db: Client) => Promise<void>, { retire = true } = {}) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await applyMyLeadsChain(db, chainThrough('offerProjections').filter((k) => k !== 'retire'));
    if (retire) await db.query(migration);
    await fn(db);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

async function seed(db: Client) {
  const org = randomUUID(), user = randomUUID(), other = randomUUID(), property = randomUUID();
  for (const id of [user, other]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1,'Retire')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active')", [user, org]);
  await db.query("insert into public.memberships(user_id,org_id,role,access_status) values ($1,$2,'member','active')", [other, org]);
  await db.query("insert into public.properties(id,org_id,address,state,status) values ($1,$2,'1 Retire Way','MO','new_lead')", [property, org]);
  return { org, user, other, property };
}

const insertTask = (db: Client, ctx: Awaited<ReturnType<typeof seed>>, type: string, extra: { id?: string } = {}) => {
  const id = extra.id ?? randomUUID();
  const appointment = type === 'appointment';
  return db.query(
    `insert into public.tasks(id,org_id,type,status,title,due_at,end_at,calendar_chain_id,assignee_id,created_by,related_property_id)
     values ($1,$2,$3,'open','Retire test',$4,$5,$6,$7,$7,$8) returning id`,
    [id, ctx.org, type, new Date(Date.now() + DAY).toISOString(),
      appointment ? new Date(Date.now() + DAY + 15 * 60_000).toISOString() : null,
      appointment ? randomUUID() : null, ctx.user, ctx.property]);
};

// Runs one statement under a savepoint and returns its error text (or null), restoring the role.
async function attempt(db: Client, role: 'service_role' | 'authenticated' | 'postgres', userId: string, run: () => Promise<unknown>) {
  await db.query('savepoint s');
  if (role !== 'postgres') {
    await db.query(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
  }
  let failure: string | null = null;
  try { await run(); } catch (error) { failure = String((error as Error).message); }
  await db.query('rollback to savepoint s');
  await db.query('reset role');
  return failure;
}

it('rejects new follow_up and callback rows for every role and still accepts appointment and custom', async () => {
  await withDb(async (db) => {
    const ctx = await seed(db);
    for (const role of ['postgres', 'service_role', 'authenticated'] as const) {
      for (const type of ['callback', 'follow_up']) {
        const failure = await attempt(db, role, ctx.user, () => insertTask(db, ctx, type));
        // authenticated may also be stopped earlier by row security; either way the row never exists.
        expect(failure, `${role} ${type}`).toMatch(role === 'authenticated' ? /TASK_TYPE_RETIRED|row-level security/ : /TASK_TYPE_RETIRED/);
      }
    }
    // The trigger itself, independent of row security, as the owner connection:
    const owner = await attempt(db, 'postgres', ctx.user, () => insertTask(db, ctx, 'callback'));
    expect(owner).toMatch(/TASK_TYPE_RETIRED: create an appointment \(phone\) or a task instead of callback/);
    expect(await attempt(db, 'postgres', ctx.user, () => insertTask(db, ctx, 'custom'))).toBeNull();
    expect(await attempt(db, 'service_role', ctx.user, () => insertTask(db, ctx, 'custom'))).toBeNull();
    expect(await attempt(db, 'postgres', ctx.user, () => insertTask(db, ctx, 'appointment'))).toBeNull();
    expect((await db.query("select count(*)::int n from public.tasks where org_id=$1 and type in ('callback','follow_up')", [ctx.org])).rows[0].n).toBe(0);
  });
});

it('leaves historical rows alone: edits, completion and reassignment still work, but a type change into a retired value does not', async () => {
  await withDb(async (db) => {
    const ctx = await seed(db);
    const legacy = randomUUID();
    // Historical row, created before the trigger existed (the escape hatch stands in for that).
    await db.query("select set_config('sandra.allow_retired_task_type','on',true)");
    await insertTask(db, ctx, 'callback', { id: legacy });
    await db.query("select set_config('sandra.allow_retired_task_type','',true)");

    expect(await attempt(db, 'postgres', ctx.user, () => db.query("update public.tasks set title='renamed' where id=$1", [legacy]))).toBeNull();
    expect(await attempt(db, 'postgres', ctx.user, () => db.query("update public.tasks set status='completed' where id=$1", [legacy]))).toBeNull();
    expect(await attempt(db, 'postgres', ctx.user, () => db.query('update public.tasks set assignee_id=$2 where id=$1', [legacy, ctx.other]))).toBeNull();
    // Same-value type update is not a type change.
    expect(await attempt(db, 'postgres', ctx.user, () => db.query("update public.tasks set type='callback' where id=$1", [legacy]))).toBeNull();

    const custom = randomUUID();
    await insertTask(db, ctx, 'custom', { id: custom });
    for (const type of ['callback', 'follow_up']) {
      expect(await attempt(db, 'postgres', ctx.user, () => db.query('update public.tasks set type=$2 where id=$1', [custom, type]))).toMatch(/TASK_TYPE_RETIRED/);
    }
    // Converting a legacy row to a live type is fine (what the relabel does).
    expect(await attempt(db, 'postgres', ctx.user, () => db.query("update public.tasks set type='custom' where id=$1", [legacy]))).toBeNull();
  });
});

it('honors the sandra.allow_retired_task_type escape hatch only while it is on', async () => {
  await withDb(async (db) => {
    const ctx = await seed(db);
    await db.query("select set_config('sandra.allow_retired_task_type','on',true)");
    expect(await attempt(db, 'postgres', ctx.user, () => insertTask(db, ctx, 'follow_up'))).toBeNull();
    await db.query("select set_config('sandra.allow_retired_task_type','off',true)");
    expect(await attempt(db, 'postgres', ctx.user, () => insertTask(db, ctx, 'follow_up'))).toMatch(/TASK_TYPE_RETIRED/);
    await db.query("select set_config('sandra.allow_retired_task_type','',true)");
    expect(await attempt(db, 'postgres', ctx.user, () => insertTask(db, ctx, 'callback'))).toMatch(/TASK_TYPE_RETIRED/);
  });
});

it('keeps the shared next-step function working: a phone appointment and a task are created, never a retired type', async () => {
  await withDb(async (db) => {
    const ctx = await seed(db);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [ctx.user]);
    const call = async (kind: 'appointment' | 'task', title: string) => {
      const r = await db.query(
        `select public.fn_create_next_step(p_org := $1, p_actor := $2, p_assignee := $2, p_kind := $3, p_title := $4,
           p_due_at := $5, p_property := $6, p_mode := 'phone', p_origin := 'app', p_enforce_window := true) as r`,
        [ctx.org, ctx.user, kind, title, new Date(Date.now() + 2 * DAY).toISOString(), ctx.property]);
      return r.rows[0].r;
    };
    await db.query('savepoint fn');
    let appointment, task;
    try {
      appointment = await call('appointment', 'Call 1 Retire Way');
      task = await call('task', 'Pull comps');
    } catch (e) { await db.query('rollback to savepoint fn'); throw e; }
    const rows = (await db.query('select type from public.tasks where id = any($1::uuid[]) order by type', [[appointment.task_id, task.task_id]])).rows.map((r) => r.type);
    expect(rows).toEqual(['appointment', 'custom']);
  });
});

it('the rollback twin drops the trigger and its function and leaves the retire preflight in place', async () => {
  await withDb(async (db) => {
    const has = async () => (await db.query("select exists (select 1 from pg_trigger where tgname='trg_tasks_reject_retired_types' and not tgisinternal) as t, to_regproc('public.tasks_reject_retired_types') is not null as f, to_regproc('public.fn_my_leads_next_step_retire_preflight') is not null as p")).rows[0];
    expect(await has()).toEqual({ t: true, f: true, p: true });
    await db.query(rollbackFile);
    expect(await has()).toEqual({ t: false, f: false, p: true });
    const ctx = await seed(db);
    expect(await attempt(db, 'postgres', ctx.user, () => insertTask(db, ctx, 'callback'))).toBeNull();
  });
});

it('the function is not callable by anon or authenticated clients', async () => {
  await withDb(async (db) => {
    const privs = (await db.query("select has_function_privilege('anon','public.tasks_reject_retired_types()','execute') as a, has_function_privilege('authenticated','public.tasks_reject_retired_types()','execute') as u")).rows[0];
    expect(privs).toEqual({ a: false, u: false });
  });
});
