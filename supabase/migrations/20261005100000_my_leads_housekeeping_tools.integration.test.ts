import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { applyP1e, MIGRATIONS, readSql } from '@tests/integration/my-leads-housekeeping-fixture';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

const sql = readSql(MIGRATIONS.tools);
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

it('creates closed run and before-image tables and a service-only gate', async () => {
  if (!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  requireLoopbackPostgresUrl(url);
  if (!/^begin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error('Migration transaction wrapper changed');
  expect(sql).not.toMatch(/^\s*(insert|update|delete)\s/im); // no data step in a migration
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('begin');
    await applyP1e(db, 'tools');
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
    for (const role of ['authenticated', 'anon', 'service_role'] as const) {
      for (const table of ['my_leads_housekeeping_runs', 'my_leads_housekeeping_before_images']) {
        await expectError(() => as(role, () => db.query(`select * from public.${table}`)), /permission denied/);
        await expectError(() => as(role, () => db.query(`insert into public.${table} default values`)), /permission denied/);
      }
      await expectError(() => as(role, () => db.query('select public.my_leads_housekeeping_require_service()')), /permission denied/);
    }
    // The gate itself: only a service-role claim passes (the definer functions call it as owner).
    await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
    await expectError(() => db.query('select public.my_leads_housekeeping_require_service()'), /service role required/);
    await db.query("select set_config('request.jwt.claim.role','service_role',true)");
    await db.query('select public.my_leads_housekeeping_require_service()');

    // Constraints and cascade (as the owner, the only role that can touch the tables).
    const org = randomUUID();
    await db.query("insert into public.organizations(id,name) values ($1,'Ledger')", [org]);
    const run = (await db.query("insert into public.my_leads_housekeeping_runs(org_id,kind) values ($1,'reassign') returning id,status", [org])).rows[0];
    expect(run.status).toBe('applied');
    await expectError(() => db.query("insert into public.my_leads_housekeeping_runs(org_id,kind) values ($1,'bogus')", [org]), /check constraint/);
    await expectError(() => db.query("insert into public.my_leads_housekeeping_runs(org_id,kind,status) values ($1,'reassign','weird')", [org]), /check constraint/);
    await db.query("insert into public.my_leads_housekeeping_before_images(run_id,table_name,row_id,before) values ($1,'tasks',$2,'{}')", [run.id, randomUUID()]);
    await expectError(() => db.query("insert into public.my_leads_housekeeping_before_images(run_id,table_name,row_id,before) values ($1,'users',$2,'{}')", [run.id, randomUUID()]), /check constraint/);
    await db.query('delete from public.my_leads_housekeeping_runs where id=$1', [run.id]);
    expect((await db.query('select count(*)::int n from public.my_leads_housekeeping_before_images where run_id=$1', [run.id])).rows[0].n).toBe(0);
  } finally { await db.query('rollback').catch(() => {}); await db.end(); }
});
