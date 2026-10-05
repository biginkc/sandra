import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';
import { applyMyLeadsChain, chainThrough } from '@tests/integration/my-leads-housekeeping-fixture';

// Local-only: every test runs inside one transaction that is rolled back. applyMyLeadsChain leaves
// the database with exactly the My Leads stack through this migration applied (P1a-core's flags
// table included), whatever it held before.
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
type PgError = Error & { code?: string };

async function withTx(fn: (db: Client) => Promise<void>) {
  const db = new Client({ connectionString: requireLoopbackPostgresUrl(url) });
  await db.connect();
  try {
    await db.query('begin');
    await applyMyLeadsChain(db, chainThrough('leadComps'));
    await fn(db);
  } finally {
    await db.query('rollback').catch(() => undefined);
    await db.end();
  }
}

const asService = (db: Client) =>
  db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true), set_config('role', 'service_role', true)`);
const asUser = (db: Client, userId: string) =>
  db.query(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ role: 'authenticated', sub: userId })]);
const asNone = (db: Client) => db.query(`select set_config('request.jwt.claims', '', true), set_config('role', 'postgres', true)`);

type Seed = { orgA: string; orgB: string; userA: string; userB: string; propA: string; propA2: string; propTraining: string; propB: string };
async function seed(db: Client): Promise<Seed> {
  const s: Seed = { orgA: randomUUID(), orgB: randomUUID(), userA: randomUUID(), userB: randomUUID(), propA: randomUUID(), propA2: randomUUID(), propTraining: randomUUID(), propB: randomUUID() };
  for (const [org, user] of [[s.orgA, s.userA], [s.orgB, s.userB]] as const) {
    await db.query(`insert into auth.users (id, email, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values ($1, $2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}', '{}', now(), now())`, [user, `${user}@example.test`]);
    await db.query(`insert into public.organizations (id, name) values ($1, $2)`, [org, `Org ${org.slice(0, 8)}`]);
    await db.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`, [org, user]);
  }
  const prop = (id: string, org: string) =>
    db.query(`insert into public.properties (id, org_id, address, city, state, zip) values ($1, $2, $3, 'Sample City', 'MO', '64000')`, [id, org, `${id.slice(0, 6)} Sample Ave`]);
  await prop(s.propA, s.orgA); await prop(s.propA2, s.orgA); await prop(s.propB, s.orgB);
  // A training lead needs a dedicated contact and the service role (guard_training_property).
  const contact = randomUUID();
  await db.query(`insert into public.contacts (id, org_id, first_name) values ($1, $2, 'Training seller')`, [contact, s.orgA]);
  await asService(db);
  await db.query(`insert into public.properties (id, org_id, address, state, homeowner_contact_id, is_training) values ($1, $2, 'Training Way', 'MO', $3, true)`, [s.propTraining, s.orgA, contact]);
  await asNone(db);
  return s;
}
const enqueue = async (db: Client, org: string, prop: string, trigger = 'manual') =>
  (await db.query(`select public.fn_enqueue_comp_fetch($1, $2, $3, null) as r`, [org, prop, trigger])).rows[0].r as { status: string; requestId?: string };
const settings = (db: Client, org: string, cap: number, extra = '') =>
  db.query(`insert into public.org_comp_settings (org_id, monthly_call_cap, calls_per_comp, auto_comp_enabled ${extra ? ',' + extra.split('=')[0] : ''})
            values ($1, $2, 3, true ${extra ? ',' + extra.split('=')[1] : ''})
            on conflict (org_id) do update set monthly_call_cap = excluded.monthly_call_cap`, [org, cap]);

describe('20261007100000_lead_comps_foundation', () => {
  it('RLS: a member reads own-org lead_comps, none of org B, and raw is denied; no member writes', async () => {
    await withTx(async (db) => {
      const s = await seed(db);
      await db.query(`insert into public.lead_comps (org_id, property_id, provider, as_is_value, raw) values ($1, $2, 'fixture', 100000, '{"secret":1}'), ($3, $4, 'fixture', 200000, '{}')`, [s.orgA, s.propA, s.orgB, s.propB]);
      await asUser(db, s.userA);
      const mine = await db.query(`select id, org_id, as_is_value, arv_estimate from public.lead_comps`);
      expect(mine.rows).toHaveLength(1);
      expect(mine.rows[0].org_id).toBe(s.orgA);
      expect(mine.rows[0].arv_estimate).toBeNull();
      await db.query('savepoint r');
      const raw = await db.query(`select raw from public.lead_comps`).catch((e: PgError) => e);
      expect((raw as PgError).code).toBe('42501');
      await db.query('rollback to savepoint r');
      const star = await db.query(`select * from public.lead_comps`).catch((e: PgError) => e);
      expect((star as PgError).code).toBe('42501');
      await db.query('rollback to savepoint r');
      for (const sql of [
        `insert into public.lead_comps (org_id, property_id, provider) values ('${s.orgA}', '${s.propA}', 'fixture')`,
        `update public.lead_comps set as_is_value = 1`,
        `insert into public.org_comp_settings (org_id) values ('${s.orgA}')`,
        `insert into public.comp_fetch_requests (org_id, property_id, trigger) values ('${s.orgA}', '${s.propA}', 'manual')`,
        `insert into public.lead_valuation_inputs (org_id, property_id, set_by) values ('${s.orgA}', '${s.propA}', '${s.userA}')`,
      ]) {
        const err = await db.query(`savepoint w; ${sql}`).catch((e: PgError) => e);
        expect((err as PgError).code, sql).toBe('42501');
        await db.query('rollback to savepoint w');
      }
      await db.query('savepoint f');
      const fns = await db.query(`select public.fn_enqueue_comp_fetch($1, $2, 'manual', null)`, [s.orgA, s.propA]).catch((e: PgError) => e);
      expect((fns as PgError).code).toBe('42501');
      await db.query('rollback to savepoint f');
    });
  });

  it('fn_enqueue_comp_fetch: disabled at cap 0 / missing row, unavailable for training, queued then in_flight, fresh inside TTL', async () => {
    await withTx(async (db) => {
      const s = await seed(db);
      await asService(db);
      expect(await enqueue(db, s.orgA, s.propA)).toEqual({ status: 'disabled' }); // no settings row = cap 0
      await asNone(db); await settings(db, s.orgA, 0); await asService(db);
      expect(await enqueue(db, s.orgA, s.propA)).toEqual({ status: 'disabled' });
      await asNone(db); await settings(db, s.orgA, 30); await asService(db);
      expect(await enqueue(db, s.orgA, s.propTraining)).toEqual({ status: 'unavailable' });
      expect(await enqueue(db, s.orgA, s.propB)).toEqual({ status: 'unavailable' }); // other org's property
      const first = await enqueue(db, s.orgA, s.propA);
      expect(first.status).toBe('queued');
      expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await enqueue(db, s.orgA, s.propA)).toEqual({ status: 'in_flight' });
      expect(await enqueue(db, s.orgA, s.propA, 'top_ten')).toEqual({ status: 'in_flight' });
      // top_ten is refused when auto comps are off
      await asNone(db); await db.query(`update public.org_comp_settings set auto_comp_enabled = false where org_id = $1`, [s.orgA]); await asService(db);
      expect(await enqueue(db, s.orgA, s.propA2, 'top_ten')).toEqual({ status: 'disabled' });
      // fresh: a row younger than ttl_days (manual: younger than manual_refresh_min_hours)
      await db.query(`insert into public.lead_comps (org_id, property_id, provider, fetched_at) values ($1, $2, 'fixture', now() - interval '2 hours')`, [s.orgA, s.propA2]);
      expect(await enqueue(db, s.orgA, s.propA2, 'manual')).toEqual({ status: 'fresh' });
      await db.query(`update public.lead_comps set fetched_at = now() - interval '2 days' where property_id = $1`, [s.propA2]);
      expect((await enqueue(db, s.orgA, s.propA2, 'manual')).status).toBe('queued');
    });
  });

  it('fn_claim_comp_fetches: manual first, caps at used + calls_per_comp > cap, counts only the current Chicago month; finish trues up; reap times out', async () => {
    await withTx(async (db) => {
      const s = await seed(db);
      await settings(db, s.orgA, 6); // two comps of 3 calls fit, a third does not
      await asService(db);
      // An old-month reservation must not count.
      await db.query(`insert into public.comp_fetch_requests (org_id, property_id, trigger, status, reserved_calls, started_at, finished_at)
        values ($1, $2, 'manual', 'ok', 3, (date_trunc('month', now() at time zone 'America/Chicago') at time zone 'America/Chicago') - interval '1 day', now())`, [s.orgA, s.propA]);
      const topTen = await enqueue(db, s.orgA, s.propA, 'top_ten');
      const manual = await enqueue(db, s.orgA, s.propA2, 'manual');
      expect(topTen.status).toBe('queued'); expect(manual.status).toBe('queued');
      const claimed = await db.query(`select id, trigger, status, reserved_calls, attempts from public.fn_claim_comp_fetches(10)`);
      expect(claimed.rows.map((r) => r.trigger)).toEqual(['manual', 'top_ten']);
      expect(claimed.rows.every((r) => r.status === 'running' && r.reserved_calls === 3 && r.attempts === 1)).toBe(true);
      // Third request: used 6 + 3 > 6 → capped
      await db.query(`update public.comp_fetch_requests set status = 'ok', finished_at = now() where id = $1`, [claimed.rows[1].id]);
      const third = await enqueue(db, s.orgA, s.propA, 'manual');
      expect(third.status).toBe('queued');
      expect((await db.query(`select count(*)::int as n from public.fn_claim_comp_fetches(10)`)).rows[0].n).toBe(0);
      expect((await db.query(`select status from public.comp_fetch_requests where id = $1`, [third.requestId])).rows[0].status).toBe('capped');
      // finish trues up reserved_calls to billed
      await db.query(`select public.fn_finish_comp_fetch($1, 'ok', 2, null, null)`, [claimed.rows[0].id]);
      const done = (await db.query(`select status, reserved_calls, billed_calls, finished_at from public.comp_fetch_requests where id = $1`, [claimed.rows[0].id])).rows[0];
      expect(done).toMatchObject({ status: 'ok', reserved_calls: 2, billed_calls: 2 });
      expect(done.finished_at).not.toBeNull();
      // reap: running > 5 minutes → error/TIMEOUT, reservation kept
      await db.query(`update public.comp_fetch_requests set status = 'running', started_at = now() - interval '6 minutes', finished_at = null where id = $1`, [claimed.rows[1].id]);
      expect((await db.query(`select public.fn_reap_stuck_comp_fetches() as n`)).rows[0].n).toBe(1);
      expect((await db.query(`select status, error_code, reserved_calls from public.comp_fetch_requests where id = $1`, [claimed.rows[1].id])).rows[0]).toMatchObject({ status: 'error', error_code: 'TIMEOUT', reserved_calls: 3 });
    });
  });

  it('fn_enqueue_comp_fetch: no_match inside TTL and error inside backoff do not re-queue', async () => {
    await withTx(async (db) => {
      const s = await seed(db);
      await settings(db, s.orgA, 30);
      await asService(db);
      const finished = (prop: string, status: string, code: string | null, ago: string) =>
        db.query(`insert into public.comp_fetch_requests (org_id, property_id, trigger, status, error_code, started_at, finished_at)
          values ($1, $2, 'manual', $3, $4, now() - interval '${ago}', now() - interval '${ago}')`, [s.orgA, prop, status, code]);
      // no_match: fresh inside ttl_days (30), re-queues after.
      await finished(s.propA, 'no_match', null, '2 days');
      expect(await enqueue(db, s.orgA, s.propA, 'top_ten')).toEqual({ status: 'fresh', noMatch: true });
      await db.query(`update public.comp_fetch_requests set finished_at = now() - interval '40 days' where property_id = $1`, [s.propA]);
      expect((await enqueue(db, s.orgA, s.propA, 'top_ten')).status).toBe('queued');
      // error: default 6h backoff
      await finished(s.propA2, 'error', 'AUTH', '1 hour');
      expect(await enqueue(db, s.orgA, s.propA2)).toEqual({ status: 'backoff' });
      await db.query(`update public.comp_fetch_requests set finished_at = now() - interval '7 hours' where property_id = $1`, [s.propA2]);
      expect((await enqueue(db, s.orgA, s.propA2)).status).toBe('queued');
      // RATE_LIMIT_RETRY_n hint is honoured: 2 hours elapsed < 10000s (~2.8h) -> backoff; > -> queued
      await db.query(`update public.comp_fetch_requests set status = 'cancelled' where property_id = $1 and status = 'queued'`, [s.propA2]);
      await finished(s.propA2, 'error', 'RATE_LIMIT_RETRY_10000', '2 hours');
      expect(await enqueue(db, s.orgA, s.propA2)).toEqual({ status: 'backoff' });
      await db.query(`update public.comp_fetch_requests set finished_at = now() - interval '3 hours' where error_code = 'RATE_LIMIT_RETRY_10000'`);
      expect((await enqueue(db, s.orgA, s.propA2)).status).toBe('queued');
    });
  });

  it('fn_claim_comp_fetches(p_limit, p_request_id) claims only that row; calls_per_comp minimum is 2', async () => {
    await withTx(async (db) => {
      const s = await seed(db);
      await settings(db, s.orgA, 30);
      await settings(db, s.orgB, 30);
      await asService(db);
      const a = await enqueue(db, s.orgA, s.propA);
      const b = await enqueue(db, s.orgB, s.propB);
      const claimed = await db.query(`select id, org_id from public.fn_claim_comp_fetches(1, $1)`, [b.requestId]);
      expect(claimed.rows.map((r) => r.id)).toEqual([b.requestId]);
      expect((await db.query(`select status from public.comp_fetch_requests where id = $1`, [a.requestId])).rows[0].status).toBe('queued');
      // calls_per_comp boundary: 1 rejected, 2 accepted.
      await asNone(db);
      await db.query('savepoint c');
      const bad = await db.query(`update public.org_comp_settings set calls_per_comp = 1 where org_id = $1`, [s.orgA]).catch((e: PgError) => e);
      expect((bad as PgError).code).toBe('23514');
      await db.query('rollback to savepoint c');
      await db.query(`update public.org_comp_settings set calls_per_comp = 2 where org_id = $1`, [s.orgA]);
    });
  });

  it('fn_set_lead_valuation_inputs: member upserts, non-member and negative rehab rejected', async () => {
    await withTx(async (db) => {
      const s = await seed(db);
      await asUser(db, s.userA);
      const r = (await db.query(`select public.fn_set_lead_valuation_inputs($1, $2, 250000, 0) as r`, [s.orgA, s.propA])).rows[0].r;
      expect(r).toMatchObject({ arv: 250000, rehab: 0, setBy: s.userA });
      await db.query(`select public.fn_set_lead_valuation_inputs($1, $2, 260000, 15000)`, [s.orgA, s.propA]);
      const row = (await db.query(`select arv::float as arv, rehab::float as rehab from public.lead_valuation_inputs where property_id = $1`, [s.propA])).rows[0];
      expect(row).toEqual({ arv: 260000, rehab: 15000 });
      await db.query('savepoint v');
      const neg = await db.query(`select public.fn_set_lead_valuation_inputs($1, $2, 260000, -1)`, [s.orgA, s.propA]).catch((e: PgError) => e);
      expect((neg as PgError).code).toBe('22023');
      await db.query('rollback to savepoint v');
      await asUser(db, s.userB);
      const forbidden = await db.query(`select public.fn_set_lead_valuation_inputs($1, $2, 1, 1)`, [s.orgA, s.propA]).catch((e: PgError) => e);
      expect((forbidden as PgError).code).toBe('42501');
    });
  });
});
