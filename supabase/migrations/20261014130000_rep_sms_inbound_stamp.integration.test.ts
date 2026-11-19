import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, '').replace(/^\s*commit;\s*$/gim, '');
const read = (rel: string) => strip(readFileSync(path.join(__dirname, rel), 'utf8'));
const MIGRATION = read('20261014130000_rep_sms_inbound_stamp.sql');
const ROLLBACK = read('../rollbacks/20261014130000_rep_sms_inbound_stamp.sql');
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

it('binds the reply stamp first-writer-wins, org-scoped, service_role only, and rolls back', async () => {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  const bind = async (kind: string, id: string, org: string, inbound: string | null) =>
    (await db.query('select public.fn_bind_rep_sms_inbound_stamp($1,$2,$3,$4) as v', [kind, id, org, inbound])).rows[0].v as string | null;
  const read = async (kind: string, id: string, org: string) =>
    (await db.query('select public.fn_get_rep_sms_inbound_stamp($1,$2,$3) as v', [kind, id, org])).rows[0].v as string | null;
  try {
    await db.query('begin');
    await db.query(MIGRATION);
    // Idempotent re-apply.
    await db.query(MIGRATION);

    const org = randomUUID(), otherOrg = randomUUID(), rep = randomUUID();
    await db.query('insert into auth.users(id) values ($1)', [rep]);
    for (const id of [org, otherOrg]) await db.query("insert into public.organizations(id,name) values ($1,$2)", [id, `stamp-${id}`]);
    const property = randomUUID(), contact = randomUUID();
    await db.query("insert into public.properties(id,org_id,address,state,status) values ($1,$2,'Stamp Main','MO','new_lead')", [property, org]);
    const attempt = randomUUID();
    await db.query(
      "insert into public.acquisition_attempts(id,org_id,property_id,actor_user_id,attempt_kind,source,occurred_at,provider_attempt_key,idempotency_key) values ($1,$2,$3,$4,'call','sandra',now(),$5,$6)",
      [attempt, org, property, rep, `stamp-${randomUUID()}`, randomUUID()]);
    const obligation = randomUUID();
    await db.query(
      "insert into public.rep_sms_obligations(id,org_id,property_id,attempt_id,actor_user_id) values ($1,$2,$3,$4,$5)",
      [obligation, org, property, attempt, rep]);
    const ledger = randomUUID();
    await db.query(
      "insert into public.rep_sms_delivery_ledger(id,org_id,actor_user_id,submission_key,property_id,contact_id,sender_assignment_id,provider,provider_account_id,provider_sender_id,from_number,to_number,body,claim_token) values ($1,$2,$3,$4,$5,$6,$7,'sendillo','a','s','+18163706846','+18165550123','hi',$8)",
      [ledger, org, rep, randomUUID(), property, contact, randomUUID(), randomUUID()]);

    const x = randomUUID(), y = randomUUID();
    for (const [kind, id] of [['obligation', obligation], ['draft', ledger]] as const) {
      expect(await read(kind, id, org)).toBeNull();            // nothing stored yet
      expect(await bind(kind, id, org, null)).toBeNull();      // nothing stored yet, null does not bind
      expect(await bind(kind, id, org, x)).toBe(x);            // first writer wins
      expect(await bind(kind, id, org, y)).toBe(x);            // later capture never replaces it
      expect(await bind(kind, id, org, null)).toBe(x);         // read-back with no supplied value
      expect(await read(kind, id, org)).toBe(x);               // read-only path sees it
      expect(await bind(kind, id, otherOrg, y)).toBeNull();    // cross-org sees and changes nothing
      expect(await read(kind, id, otherOrg)).toBeNull();
    }
    // A SQL exception aborts the transaction; recover with a savepoint so the
    // permission and rollback checks below still execute.
    await db.query('savepoint bad_kind');
    await expect(bind('nope', obligation, org, x)).rejects.toThrow(/unknown stamp kind/);
    await db.query('rollback to savepoint bad_kind');

    // Only service_role may call it.
    await db.query('savepoint denied');
    await db.query('set local role authenticated');
    await expect(bind('draft', ledger, org, y)).rejects.toThrow(/permission denied/);
    await db.query('rollback to savepoint denied');
    await db.query('savepoint denied_read');
    await db.query('set local role authenticated');
    await expect(read('draft', ledger, org)).rejects.toThrow(/permission denied/);
    await db.query('rollback to savepoint denied_read');
    await db.query('reset role');

    // Rollback removes exactly what was added.
    await db.query(ROLLBACK);
    const left = await db.query(
      "select (select count(*) from information_schema.columns where column_name='inbound_message_id' and table_name in ('rep_sms_obligations','rep_sms_delivery_ledger'))::int cols, (select count(*) from pg_proc where proname in ('fn_bind_rep_sms_inbound_stamp','fn_get_rep_sms_inbound_stamp'))::int fns");
    expect(left.rows[0]).toEqual({ cols: 0, fns: 0 });
  } finally {
    await db.query('rollback').catch(() => undefined);
    await db.end();
  }
});
