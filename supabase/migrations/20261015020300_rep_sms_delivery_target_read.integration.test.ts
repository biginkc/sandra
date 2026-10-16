import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

// My Leads unified queue, Phase B1: fn_get_rep_sms_delivery_target (read one ledger receipt by id for the actor). The database must already hold the
// repo's migrations; the local disposable stack may lag, so this suite also replays the classifier and flag
// migrations when they are missing, and always re-applies its own migration, all inside a rolled-back transaction.
const read = (file: string) => {
  const sql = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error(`transaction wrapper changed in ${file}`);
  return sql.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
};
const classifierSql = read('20261015010000_my_leads_work_queue_classifier.sql');
const flagSql = read('20261015020000_my_leads_unified_queue_flag.sql');
const migrationSql = read('20261015020300_rep_sms_delivery_target_read.sql');
const rollbackSql = (() => {
  const sql = readFileSync(new URL('../rollbacks/20261015020300_rep_sms_delivery_target_read.sql', import.meta.url), 'utf8');
  if (!/\bbegin;/i.test(sql) || !/commit;\s*$/i.test(sql)) throw new Error('transaction wrapper changed in the rollback');
  return sql.replace(/^[\s\S]*?\bbegin;\s*/i, '').replace(/\s*commit;\s*$/i, '');
})();
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function withDb(fn: (db: Client) => Promise<void>) {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    const hasClassifier = (await db.query("select to_regprocedure('public.fn_my_leads_work_page(uuid,uuid,text,text,text,text,integer,integer,timestamptz)') as f")).rows[0].f;
    if (!hasClassifier) await db.query(classifierSql);
    await db.query(flagSql);
    await db.query(migrationSql);
    await fn(db);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
}

async function world(db: Client) {
  const org = randomUUID(), owner = randomUUID(), sam = randomUUID(), other = randomUUID(), outsider = randomUUID();
  for (const id of [owner, sam, other, outsider]) await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query("insert into public.organizations(id,name) values ($1,'Pin queue')", [org]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [owner, org]);
  for (const id of [sam, other]) await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')", [id, org]);
  const org2 = randomUUID();
  await db.query("insert into public.organizations(id,name) values ($1,'Other org')", [org2]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [outsider, org2]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled,needs_sequence_owner_id) values ($1,true,$2)', [org, owner]);
  await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled,needs_sequence_owner_id) values ($1,true,$2)', [org2, outsider]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
  for (const id of [owner, sam, other]) {
    await db.query("select set_config('my_leads.designation_update',$1,true)", [`${owner}:${org}:${id}`]);
    await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2', [id, org]);
  }
  await db.query("select set_config('my_leads.designation_update','',true)");
  await db.query("select set_config('request.jwt.claim.sub','',true)");

  for (const id of [sam, other]) await db.query('insert into public.rep_sms_rollout_enrollments(org_id,user_id,enabled,enrolled_at,enrolled_by) values ($1,$2,true,now(),$3)', [org, id, owner]);
  let phoneSeq = 0;
  const raw = async (sql: string, params: unknown[]) => {
    await db.query("set local session_replication_role='replica'");
    try { await db.query(sql, params); } catch (error) { await db.query('rollback'); throw error; }
    await db.query("set local session_replication_role='origin'");
  };
  const attempt = (property: string, when: string) => raw(
    "insert into public.acquisition_attempts(org_id,property_id,actor_user_id,attempt_kind,source,occurred_at,recorded_at,idempotency_key,outcome) values ($1,$2,$3,'outreach','manual',$4,$4,$5,'no_answer')",
    [org, property, sam, when, randomUUID()]);
  const lead = async (key: string, assignee = sam) => {
    const id = randomUUID(), contact = randomUUID();
    phoneSeq += 1;
    await db.query('insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values ($1,$2,$3,$4,$5,$6)', [contact, org, key, 'Lead', `+181655${String(phoneSeq).padStart(5, '0')}`, 'mobile']);
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id,homeowner_contact_id) values ($1,$2,$3,'MO','new_lead',$4,$5)", [id, org, `${key} Main`, assignee, contact]);
    // Worked once a month ago, so it is not a brand-new lead by accident.
    await attempt(id, new Date(Date.now() - 30 * DAY).toISOString());
    return id;
  };
  const ledger = async (property: string, state: string, updated: string) => {
    const contact = (await db.query('select homeowner_contact_id as c from public.properties where id=$1', [property])).rows[0].c;
    const id = randomUUID();
    await raw(
      `insert into public.rep_sms_delivery_ledger(id,org_id,actor_user_id,submission_key,property_id,contact_id,sender_assignment_id,provider,provider_account_id,provider_sender_id,from_number,to_number,body,state,claim_token,message_id,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,'sendillo','acct','sender','+18165550100','+18165550101','hi',$8,$9,null,$10,$10)`,
      [id, org, sam, randomUUID(), property, contact, randomUUID(), state, randomUUID(), updated]);
    return id;
  };
  const as = async <T,>(role: 'authenticated' | 'anon', sub: string | null, run: () => Promise<T>) => {
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
  const target = (sub: string, property: string, ledgerId: string) =>
    as('authenticated', sub, async () => (await db.query('select public.fn_get_rep_sms_delivery_target($1,$2) as r', [property, ledgerId])).rows[0].r as Json);
  return { org, org2, owner, sam, other, outsider, lead, ledger, attempt, as, expectError, target, raw };
}


it('returns the actor own receipt by id, whatever its recovery state', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const p = await w.lead('mine');
    const open = await w.ledger(p, 'unknown', new Date().toISOString());
    const closed = await w.ledger(p, 'delivery_failed', new Date().toISOString());
    await db.query('update public.rep_sms_delivery_ledger set recovery_open=false where id=$1', [closed]);
    for (const id of [open, closed]) {
      const r = await w.target(w.sam, p, id);
      expect(r.target).toMatchObject({ receiptId: id, from: '+18165550100', to: '+18165550101', body: 'hi' });
      expect(Object.keys(r.target).sort()).toEqual(['assignmentId', 'body', 'composition', 'from', 'key', 'lastPreDispatchFailure', 'providerError', 'receiptId', 'state', 'to']);
    }
    expect((await w.target(w.sam, p, closed)).target.state).toBe('delivery_failed');
  });
});

it('another user, another property, an unknown id and a not-enrolled caller get target null', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const p = await w.lead('mine'), q = await w.lead('other-prop');
    const id = await w.ledger(p, 'unknown', new Date().toISOString());
    // Another rep: the lead is not in their queue, so the draft function's own scope check denies them (42501).
    await w.expectError(() => w.target(w.other, p, id), /queue/);
    // Same rep scope but a receipt that belongs to another actor: give `other` the lead, then they still see null.
    await db.query('update public.rep_sms_delivery_ledger set actor_user_id=$2 where id=$1', [id, w.other]);
    expect((await w.target(w.sam, p, id)).target).toBeNull();
    await db.query('update public.rep_sms_delivery_ledger set actor_user_id=$2 where id=$1', [id, w.sam]);
    expect((await w.target(w.sam, q, id)).target).toBeNull();               // right id, wrong property
    expect((await w.target(w.sam, p, randomUUID())).target).toBeNull();
    await db.query('update public.rep_sms_rollout_enrollments set enabled=false, enrolled_at=null, enrolled_by=null where user_id=$1', [w.sam]);
    expect((await w.target(w.sam, p, id)).target).toBeNull();
  });
});

it('a caller outside the org, an anonymous caller and a lead not in the queue are denied', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const p = await w.lead('mine');
    const id = await w.ledger(p, 'unknown', new Date().toISOString());
    await w.expectError(() => w.target(w.outsider, p, id), /./);
    await w.expectError(() => w.as('anon', null, async () => (await db.query('select public.fn_get_rep_sms_delivery_target($1,$2)', [p, id])).rows), /permission denied|Lead unavailable/);
    const unqueued = randomUUID();
    await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,'x Main','MO','new_lead',$3)", [unqueued, w.org, w.owner]);
    await w.expectError(() => w.target(w.sam, unqueued, id), /queue|Acquisitions|unavailable/i);
  });
});

it('is read-only: no ledger row changes and the function is not volatile-writing', async () => {
  await withDb(async (db) => {
    const w = await world(db);
    const p = await w.lead('mine');
    const id = await w.ledger(p, 'unknown', new Date().toISOString());
    const snap = async () => JSON.stringify((await db.query('select * from public.rep_sms_delivery_ledger order by id')).rows);
    const before = await snap();
    await w.target(w.sam, p, id);
    expect(await snap()).toBe(before);
    expect((await db.query("select has_function_privilege('anon','public.fn_get_rep_sms_delivery_target(uuid,uuid)','execute') a, has_function_privilege('authenticated','public.fn_get_rep_sms_delivery_target(uuid,uuid)','execute') u")).rows[0]).toEqual({ a: false, u: true });
  });
});

it('rollback drops the function and re-applying restores it', async () => {
  await withDb(async (db) => {
    await db.query(rollbackSql);
    expect((await db.query("select to_regprocedure('public.fn_get_rep_sms_delivery_target(uuid,uuid)') f")).rows[0].f).toBeNull();
    await db.query(migrationSql);
    expect((await db.query("select to_regprocedure('public.fn_get_rep_sms_delivery_target(uuid,uuid)') f")).rows[0].f).not.toBeNull();
  });
});
