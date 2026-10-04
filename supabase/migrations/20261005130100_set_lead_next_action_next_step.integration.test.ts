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
const prior = ['./20261005120000_next_step_schema.sql', './20261005120500_fn_create_next_step.sql'].map(strip);
const migration = strip('./20261005130100_set_lead_next_action_next_step.sql');
const rollback = strip('../rollbacks/20261005130100_set_lead_next_action_next_step.sql');
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
    for (const file of files) await db.query(file);
    await fn(db);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

async function world(db: Client) {
  const org = randomUUID(), sam = randomUUID(), outsider = randomUUID(), owner = randomUUID();
  for (const id of [sam, outsider, owner]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1,'Board action')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [owner, org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [sam, org]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
  const prop = async (status = 'new_lead') => {
    const id = randomUUID();
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,$3,'MO',$4,$5)", [id, org, `${id.slice(0, 6)} Main`, status, sam]);
    return id;
  };
  const setAction = async (sub: string, property: string, due: string, key: string) => {
    await db.query('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sub]);
    try {
      return (await db.query('select * from public.set_lead_next_action($1,$2,$3)', [property, due, key])).rows[0] as Json;
    } finally { await db.query('reset role').catch(() => {}); }
  };
  const expectError = async (run: () => Promise<unknown>, pattern: RegExp) => {
    await db.query('savepoint s');
    let failure: unknown = null;
    try { await run(); } catch (error) { failure = error; }
    await db.query('rollback to savepoint s');
    await db.query('reset role');
    expect(String((failure as Error)?.message)).toMatch(pattern);
  };
  return { org, sam, outsider, prop, setAction, expectError };
}

const due = (days: number) => new Date(Date.now() + days * DAY).toISOString();

it('creates a phone appointment carrying the retry token, and replays it', async () => {
  await withDb([...prior, migration], async (db) => {
    const w = await world(db);
    const property = await w.prop();
    const key = randomUUID();
    const when = due(2);
    const created = await w.setAction(w.sam, property, when, key);
    expect(created).toMatchObject({ type: 'appointment', status: 'open', was_created: true, related_property_id: property, assignee_id: w.sam });
    const t = (await db.query('select * from public.tasks where id=$1', [created.id])).rows[0];
    expect(t).toMatchObject({ mode: 'phone', next_step_kind: 'appointment', lead_next_action_idempotency_key: key, created_by: w.sam });
    expect(new Date(t.end_at).getTime() - new Date(t.due_at).getTime()).toBe(15 * 60_000);
    expect((await db.query('select source from public.acquisition_appointment_attribution where task_id=$1', [created.id])).rows).toEqual([{ source: 'booking_insert' }]);

    const replay = await w.setAction(w.sam, property, when, key);
    expect(replay).toMatchObject({ id: created.id, was_created: false });
    // A different due time on the same token is a conflict.
    await w.expectError(() => w.setAction(w.sam, property, due(5), key), /IDEMPOTENCY_KEY_CONFLICT/);
    // A lead with an open task returns it (unchanged one-open-task rule).
    const other = await w.setAction(w.sam, property, due(3), randomUUID());
    expect(other).toMatchObject({ id: created.id, was_created: false });
    expect((await db.query('select count(*)::int n from public.tasks where org_id=$1', [w.org])).rows[0].n).toBe(1);
  });
});

it('replays a key whose row was relabeled from follow_up to appointment', async () => {
  await withDb([...prior], async (db) => {
    const w = await world(db);
    const property = await w.prop();
    // Old world: the pre-migration function inserts a follow_up row.
    const key = randomUUID();
    const when = due(2);
    const old = await w.setAction(w.sam, property, when, key);
    expect(old.type).toBe('follow_up');
    await db.query("select set_config('sandra.allow_appointment_time_move','on',true)");
    await db.query("update public.tasks set type='appointment', mode='phone', end_at=due_at+interval '15 minutes', calendar_chain_id=gen_random_uuid() where id=$1", [old.id]);
    await db.query("select set_config('sandra.allow_appointment_time_move','',true)");
    await db.query(migration);
    const replay = await w.setAction(w.sam, property, when, key);
    expect(replay).toMatchObject({ id: old.id, was_created: false, type: 'appointment' });
  });
});

it('keeps the authorization and lead-state errors', async () => {
  await withDb([...prior, migration], async (db) => {
    const w = await world(db);
    const property = await w.prop();
    const prospect = await w.prop('prospect');
    const dnc = await w.prop();
    await db.query("set local session_replication_role='replica'");
    await db.query('update public.properties set is_dnc_locked=true where id=$1', [dnc]);
    await db.query("set local session_replication_role='origin'");
    await w.expectError(() => w.setAction(w.outsider, property, due(1), randomUUID()), /LEAD_NOT_FOUND|LEAD_FORBIDDEN/);
    await w.expectError(() => w.setAction(w.sam, dnc, due(1), randomUUID()), /DNC_LOCKED/);
    await w.expectError(() => w.setAction(w.sam, prospect, due(1), randomUUID()), /NOT_A_LEAD/);
    // The booking window now applies to a browser caller (more than two years out is refused).
    await w.expectError(() => w.setAction(w.sam, property, due(900), randomUUID()), /INVALID_INPUT/);
    expect((await db.query('select count(*)::int n from public.tasks where org_id=$1', [w.org])).rows[0].n).toBe(0);
  });
});

it('the rollback restores the follow_up writer', async () => {
  await withDb([...prior, migration, rollback], async (db) => {
    const w = await world(db);
    const property = await w.prop();
    const created = await w.setAction(w.sam, property, due(2), randomUUID());
    expect(created).toMatchObject({ type: 'follow_up', was_created: true });
  });
});
