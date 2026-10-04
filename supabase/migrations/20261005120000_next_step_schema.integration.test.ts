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
const schema = strip('./20261005120000_next_step_schema.sql');
const createFn = strip('./20261005120500_fn_create_next_step.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

const FLAGS = [
  'call_next_strip', 'post_call_prompt', 'click_to_dial', 'native_matcher', 'auto_prompt', 'callback_alert',
  'call_screen', 'contract_card', 'seller_reminders', 'artifact_fetch', 'facts_job', 'offer_projection', 'comp_queue',
];

async function withDb(fn: (db: Client) => Promise<void>) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await fn(db);
  } finally {
    await db.query('rollback').catch(() => {});
    await db.end();
  }
}

const as = async <T>(db: Client, role: 'authenticated' | 'anon' | 'service_role', fn: () => Promise<T>) => {
  await db.query(`set local role ${role}`);
  await db.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
  try { return await fn(); } finally { await db.query('reset role').catch(() => {}); }
};
const expectError = async (db: Client, run: () => Promise<unknown>, pattern: RegExp) => {
  await db.query('savepoint s');
  let failure: unknown = null;
  try { await run(); } catch (error) { failure = error; }
  await db.query('rollback to savepoint s');
  await db.query('reset role');
  expect(String((failure as Error)?.message)).toMatch(pattern);
};

async function seed(db: Client) {
  const org = randomUUID(), user = randomUUID();
  await db.query('insert into auth.users(id) values ($1)', [user]);
  await db.query("insert into public.organizations(id,name) values ($1,'Next step schema')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [user, org]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
  const property = randomUUID();
  await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,'1 Main','MO','new_lead',$3)", [property, org, user]);
  const task = async (type: string, extra: Record<string, unknown> = {}) => {
    const id = randomUUID();
    const due = new Date(Date.now() + 86_400_000);
    const appt = type === 'appointment';
    await db.query(
      `insert into public.tasks(id,org_id,type,status,title,due_at,end_at,assignee_id,created_by,calendar_chain_id,related_property_id,mode,location,lead_next_action_idempotency_key)
       values ($1,$2,$3,'open','T',$4,$5,$6,$6,$7,$8,$9,$10,$11)`,
      [id, org, type, due.toISOString(), appt ? new Date(+due + 900_000).toISOString() : null, user, appt ? randomUUID() : null,
        appt && extra.noProperty ? null : property, extra.mode ?? 'phone', extra.location ?? null, extra.leadKey ?? null]);
    return id;
  };
  return { org, user, property, task };
}

it('the preceding schema has none of the new objects', async () => {
  await withDb(async (db) => {
    const cols = await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='tasks' and column_name in ('mode','location','next_step_kind')");
    expect(cols.rows).toHaveLength(0);
    expect((await db.query("select to_regclass('public.my_leads_feature_flags') as t, to_regprocedure('public.fn_my_leads_schema_probe(text[],text[])') as f")).rows[0]).toEqual({ t: null, f: null });
  });
});

it('adds mode, location and the generated next_step_kind with safe defaults', async () => {
  await withDb(async (db) => {
    await db.query(schema);
    const { task } = await seed(db);
    const def = await db.query("select column_name,column_default,is_nullable,is_generated from information_schema.columns where table_schema='public' and table_name='tasks' and column_name in ('mode','location','next_step_kind') order by 1");
    const byName = Object.fromEntries(def.rows.map((r) => [r.column_name, r]));
    expect(byName.mode).toMatchObject({ is_nullable: 'NO' });
    expect(byName.mode.column_default).toContain("'phone'");
    expect(byName.location.is_nullable).toBe('YES');
    expect(byName.next_step_kind.is_generated).toBe('ALWAYS');
    const kinds: Record<string, string> = {};
    for (const type of ['follow_up', 'callback', 'custom', 'appointment']) {
      const id = await task(type);
      const row = (await db.query('select mode,next_step_kind from public.tasks where id=$1', [id])).rows[0];
      expect(row.mode).toBe('phone');
      kinds[type] = row.next_step_kind;
    }
    expect(kinds).toEqual({ follow_up: 'appointment', callback: 'appointment', custom: 'task', appointment: 'appointment' });
  });
});

it('enforces the mode and location constraints', async () => {
  await withDb(async (db) => {
    await db.query(schema);
    const { task } = await seed(db);
    await expectError(db, () => task('custom', { mode: 'in_person' }), /tasks_in_person_appointment_check/);
    await expectError(db, () => task('appointment', { mode: 'phone', location: '12 Oak' }), /tasks_location_check/);
    await expectError(db, () => task('appointment', { mode: 'in_person', location: 'x'.repeat(501) }), /tasks_location_check/);
    await expectError(db, () => task('appointment', { mode: 'bogus' }), /tasks_mode_check/);
    const ok = await task('appointment', { mode: 'in_person', location: '12 Oak' });
    expect((await db.query('select mode,location from public.tasks where id=$1', [ok])).rows[0]).toEqual({ mode: 'in_person', location: '12 Oak' });
  });
});

it('lets a follow_up keep its lead-next-action key when it becomes an appointment', async () => {
  await withDb(async (db) => {
    await db.query(schema);
    const { task, org } = await seed(db);
    const id = await task('follow_up', { leadKey: randomUUID() });
    const bump = () => db.query(
      "update public.tasks set type='appointment', end_at=due_at+interval '15 minutes', calendar_chain_id=gen_random_uuid() where id=$1 and org_id=$2", [id, org]);
    // The tenant guard still blocks the type change outside the lifecycle flag.
    await expectError(db, bump, /appointment identity/);
    await db.query("select set_config('sandra.allow_appointment_time_move','on',true)");
    await bump();
    await db.query("select set_config('sandra.allow_appointment_time_move','',true)");
    const row = (await db.query('select type,next_step_kind,lead_next_action_idempotency_key k from public.tasks where id=$1', [id])).rows[0];
    expect(row).toMatchObject({ type: 'appointment', next_step_kind: 'appointment' });
    expect(row.k).toBeTruthy();
    // A custom task still cannot carry the key.
    await expectError(db, () => task('custom', { leadKey: randomUUID() }), /tasks_lead_next_action_follow_up_check/);
  });
});

it('widens the attribution source check to the three new sources only', async () => {
  await withDb(async (db) => {
    await db.query(schema);
    const { task, org, user } = await seed(db);
    // The AFTER INSERT trigger already attributed each appointment as booking_insert.
    for (const source of ['relabel_2026_10', 'next_step_conversion', 'offer_backfill']) {
      const id = await task('appointment');
      await db.query("update public.acquisition_appointment_attribution set source=$2 where task_id=$1", [id, source]);
      expect((await db.query('select source from public.acquisition_appointment_attribution where task_id=$1', [id])).rows[0].source).toBe(source);
    }
    const id = await task('appointment');
    await expectError(db, () => db.query('update public.acquisition_appointment_attribution set source=$2 where task_id=$1', [id, 'bogus']), /acquisition_appointment_attribution_source_check/);
    void org; void user;
  });
});

it('creates the flag table closed to browser roles with every flag defaulting off', async () => {
  await withDb(async (db) => {
    await db.query(schema);
    const { org } = await seed(db);
    await as(db, 'service_role', () => db.query('insert into public.my_leads_feature_flags(org_id) values ($1)', [org]));
    const row = (await as(db, 'service_role', () => db.query('select * from public.my_leads_feature_flags where org_id=$1', [org]))).rows[0];
    for (const flag of FLAGS) expect(row[flag], flag).toBe(false);
    expect(Object.keys(row).filter((k) => !['org_id', 'updated_at'].includes(k)).sort()).toEqual([...FLAGS].sort());
    await expectError(db, () => as(db, 'authenticated', () => db.query('select * from public.my_leads_feature_flags')), /permission denied/);
    await expectError(db, () => as(db, 'anon', () => db.query('select * from public.my_leads_feature_flags')), /permission denied/);
    await expectError(db, () => as(db, 'authenticated', () => db.query('update public.my_leads_feature_flags set call_next_strip=true')), /permission denied/);
  });
});

it('schema probe reports existing and missing functions and columns, service role only', async () => {
  await withDb(async (db) => {
    await db.query(schema);
    const fnSig = 'public.fn_create_next_step(uuid,uuid,uuid,text,text,timestamptz,uuid,uuid,text,timestamptz,text,text,text,uuid,uuid,text,boolean,boolean)';
    const probe = (functions: string[], columns: string[]) => as(db, 'service_role', async () =>
      (await db.query('select public.fn_my_leads_schema_probe($1,$2) as r', [functions, columns])).rows[0].r);
    // Preceding step: columns exist, the write function does not yet.
    expect(await probe([fnSig, 'public.no_such_fn(uuid)', 'not a signature ((('], ['tasks.mode', 'tasks.location', 'tasks.next_step_kind', 'tasks.nope', 'nope.mode'])).toEqual({
      functions: { [fnSig]: false, 'public.no_such_fn(uuid)': false, 'not a signature (((': false },
      columns: { 'tasks.mode': true, 'tasks.location': true, 'tasks.next_step_kind': true, 'tasks.nope': false, 'nope.mode': false },
    });
    await db.query(createFn);
    expect((await probe([fnSig], [])).functions[fnSig]).toBe(true);
    await expectError(db, () => as(db, 'authenticated', () => db.query('select public.fn_my_leads_schema_probe($1,$2)', [[], []])), /permission denied|service role required/);
    await expectError(db, () => as(db, 'anon', () => db.query('select public.fn_my_leads_schema_probe($1,$2)', [[], []])), /permission denied|service role required/);
  });
});
