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
const softphone = strip('./20261005130200_jitter_softphone_callback_next_step.sql');
const main = strip('./20261005130300_jitter_writeback_callback_next_step.sql');
const mainRollback = strip('../rollbacks/20261005130300_jitter_writeback_callback_next_step.sql');
const softphoneRollback = strip('../rollbacks/20261005130200_jitter_softphone_callback_next_step.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const DAY = 86_400_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const MAIN_FN = 'public.jitter_writeback_call_activity_before_metrics';
const SOFT_FN = 'public.jitter_writeback_call_activity_softphone';

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
  const org = randomUUID(), jarrad = randomUUID(), operator = randomUUID();
  for (const id of [jarrad, operator]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1,'Jitter callback')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [jarrad, org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [operator, org]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)', [org]);
  const property = randomUUID(), contact = randomUUID();
  await db.query("insert into public.contacts(id,org_id,first_name,last_name) values ($1,$2,'Jit','Ter')", [contact, org]);
  await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id,homeowner_contact_id) values ($1,$2,'12 Callback Ln','MO','new_lead',$3,$4)", [property, org, operator, contact]);
  const session = `session-${randomUUID()}`;
  const call = async (attempt: string, body: Json, over: { fn?: string; role?: string; res?: string } = {}) => {
    const externalId = `ext-${over.res ?? attempt}`;
    const hash = `hash-${over.res ?? attempt}`;
    await db.query(
      `insert into public.webhook_events(provider,event_type,external_id,payload,org_id,request_hash,processing_status)
       values ('jitter','call_activity_writeback',$1,'{}',$2,$3,'pending') on conflict do nothing`, [externalId, org, hash]);
    await db.query(`set local role ${over.role ?? 'service_role'}`);
    await db.query("select set_config('request.jwt.claim.role',$1,true)", [over.role ?? 'service_role']);
    try {
      return (await db.query(`select ${over.fn ?? 'public.jitter_writeback_call_activity'}($1,$2::jsonb,$3,$4,$5,$6,$7,$8) as r`,
        [attempt, JSON.stringify(body), operator, externalId, null, org, null, hash])).rows[0].r as Json;
    } finally { await db.query('reset role').catch(() => {}); }
  };
  const body = (extra: Json = {}) => ({
    provider: 'jitter', org_id: org, jitter_session_id: session, property_id: property, contact_id: contact,
    operator_user_id: operator, disposition: 'callback_requested', outcome: 'connected_human', ...extra,
  });
  const tasks = async () => (await db.query('select * from public.tasks where org_id=$1 order by created_at', [org])).rows;
  const defOf = async (fn: string) => (await db.query(`select pg_get_functiondef('${fn}(text, jsonb, uuid, text, text, uuid, text, text)'::regprocedure) as d`)).rows[0].d as string;
  return { org, operator, property, contact, session, call, body, tasks, defOf };
}

it('callback_requested writes exactly one open phone appointment through fn_create_next_step; a replay adds none', async () => {
  await withDb([...prior, softphone, main], async (db) => {
    const w = await world(db);
    const callbackAt = new Date(Date.now() + 2 * DAY).toISOString();
    const attempt = `attempt-${randomUUID()}`;
    const out = await w.call(attempt, w.body({ callback_at: callbackAt }));
    expect(out.callback_task.id).toEqual(expect.any(String));
    const rows = await w.tasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: out.callback_task.id, type: 'appointment', mode: 'phone', status: 'open', assignee_id: w.operator, related_property_id: w.property, created_by: w.operator });
    expect(new Date(rows[0].due_at).toISOString()).toBe(callbackAt);
    expect(new Date(rows[0].end_at).getTime() - new Date(rows[0].due_at).getTime()).toBe(15 * 60_000);
    expect(rows[0].title).toBe('Callback 12 Callback Ln');
    expect((await db.query('select source from public.acquisition_appointment_attribution where task_id=$1', [rows[0].id])).rows).toEqual([{ source: 'booking_insert' }]);
    const ev = (await db.query("select actor_type, event_type from public.lead_events where source_id=$1", [rows[0].id])).rows;
    expect(ev).toEqual([{ actor_type: 'system', event_type: 'task_created' }]);
    const prop = (await db.query('select outreach_dispo, follow_up_at from public.properties where id=$1', [w.property])).rows[0];
    expect(prop.outreach_dispo).toBe('callback_requested');
    expect(new Date(prop.follow_up_at).toISOString()).toBe(callbackAt);

    // The same call again (same attempt, new idempotency reservation): the open appointment at
    // that time is reused, no second task.
    const replay = await w.call(attempt, w.body({ callback_at: callbackAt }), { res: `again-${attempt}` });
    expect(replay.callback_task.id).toBe(out.callback_task.id);
    expect(await w.tasks()).toHaveLength(1);
    // A past callback time (the function never had a window) is still accepted as before.
    const past = await w.call(`attempt-${randomUUID()}`, w.body({ jitter_session_id: w.session, callback_at: new Date(Date.now() - 3 * DAY).toISOString() }));
    expect(past.callback_task.id).toEqual(expect.any(String));
    expect(await w.tasks()).toHaveLength(2);
  });
});

it('a disposition without a callback creates no task, and a DNC-locked lead keeps raising before any task', async () => {
  await withDb([...prior, softphone, main], async (db) => {
    const w = await world(db);
    const out = await w.call(`attempt-${randomUUID()}`, w.body({ disposition: 'not_interested' }));
    expect(out.callback_task).toBeUndefined();
    expect(await w.tasks()).toHaveLength(0);
    await db.query("set local session_replication_role='replica'");
    await db.query('update public.contacts set do_not_contact=true where id=$1', [w.contact]);
    await db.query('update public.properties set is_dnc_locked=true where id=$1', [w.property]);
    await db.query("set local session_replication_role='origin'");
    await db.query('savepoint s');
    let failure = '';
    try { await w.call(`attempt-${randomUUID()}`, w.body({ callback_at: new Date(Date.now() + DAY).toISOString() })); } catch (e) { failure = String((e as Error).message); }
    await db.query('rollback to savepoint s');
    await db.query('reset role');
    expect(failure).toMatch(/DNC_LOCKED|do.?not.?contact|dnc/i);
    expect(await w.tasks()).toHaveLength(0);
  });
});

it('both functions are generated from the live definition: no callback task insert remains and grants are unchanged', async () => {
  await withDb([...prior, softphone, main], async (db) => {
    const w = await world(db);
    for (const fn of [MAIN_FN, SOFT_FN]) {
      const def = await w.defOf(fn);
      expect(def).toContain('fn_create_next_step');
      expect(def).toContain("t.next_step_kind = 'appointment'");
      expect(def).not.toMatch(/'callback'(?!_)/);
      expect(def).not.toContain('insert into public.tasks');
    }
    const acl = await db.query("select proname, proacl::text from pg_proc where proname in ('jitter_writeback_call_activity_before_metrics','jitter_writeback_call_activity_softphone','jitter_writeback_call_activity') order by 1");
    expect(acl.rows).toHaveLength(3);
  });
});

it('the rollback twins restore the callback-task inserts', async () => {
  await withDb([...prior, softphone, main, mainRollback, softphoneRollback], async (db) => {
    const w = await world(db);
    for (const fn of [MAIN_FN, SOFT_FN]) {
      const def = await w.defOf(fn);
      expect(def).not.toContain('fn_create_next_step');
      expect(def).toContain("t.type = 'callback'");
    }
    await w.call(`attempt-${randomUUID()}`, w.body({ callback_at: new Date(Date.now() + DAY).toISOString() }));
    const rows = await w.tasks();
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('callback');
  });
});
