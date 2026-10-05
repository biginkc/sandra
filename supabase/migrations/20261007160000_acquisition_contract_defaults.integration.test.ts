import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';
import { applyMyLeadsChain, chainThrough, stripTransaction } from '@tests/integration/my-leads-housekeeping-fixture';

// Local-only: every test runs inside one transaction that is rolled back.
const url = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;
type PgError = Error & { code?: string };

async function withTx(fn: (db: Client) => Promise<void>) {
  const db = new Client({ connectionString: requireLoopbackPostgresUrl(url) });
  await db.connect();
  try {
    await db.query('begin');
    await applyMyLeadsChain(db, chainThrough('contractDefaults'));
    await fn(db);
  } finally {
    await db.query('rollback').catch(() => undefined);
    await db.end();
  }
}

const asUser = (db: Client, userId: string) =>
  db.query(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ role: 'authenticated', sub: userId })]);
const asNone = (db: Client) => db.query(`select set_config('request.jwt.claims', '', true), set_config('role', 'postgres', true)`);

type Seed = { orgA: string; orgB: string; owner: string; member: string; userB: string };
async function seed(db: Client): Promise<Seed> {
  const s: Seed = { orgA: randomUUID(), orgB: randomUUID(), owner: randomUUID(), member: randomUUID(), userB: randomUUID() };
  for (const [org, user, role] of [[s.orgA, s.owner, 'owner'], [s.orgA, s.member, 'member'], [s.orgB, s.userB, 'owner']] as const) {
    await db.query(`insert into auth.users (id, email, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values ($1, $2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}', '{}', now(), now())`, [user, `${user}@example.test`]);
    await db.query(`insert into public.organizations (id, name) values ($1, $2) on conflict do nothing`, [org, `Org ${org.slice(0, 8)}`]);
    await db.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, $3, 'active')`, [org, user, role]);
  }
  return s;
}

const TABLES = [
  'acquisition_contract_title_companies',
  'acquisition_contract_buyer_entities',
  'acquisition_contract_settings',
  'acquisition_contract_title_market_defaults',
] as const;

describe('20261007160000_acquisition_contract_defaults', () => {
  it('ships empty: no title companies, buyer entities, settings or market defaults exist', async () => {
    await withTx(async (db) => {
      for (const t of TABLES) {
        expect((await db.query(`select count(*)::int as n from public.${t}`)).rows[0].n, t).toBe(0);
      }
    });
  });

  it('settings defaults: earnest money has NO default (null), follow-up 3 days at 9, no default title company or buyer', async () => {
    await withTx(async (db) => {
      const s = await seed(db);
      await db.query(`insert into public.acquisition_contract_settings (org_id) values ($1)`, [s.orgA]);
      const r = (await db.query(`select * from public.acquisition_contract_settings`)).rows[0];
      expect(r.earnest_money_cents).toBeNull();
      expect(r.follow_up_days_before_closing).toBe(3);
      expect(r.follow_up_hour_central).toBe(9);
      expect(r.default_title_company_id).toBeNull();
      expect(r.default_buyer_entity_id).toBeNull();
      expect(r.template_field_defaults).toEqual({});
    });
  });

  it('earnest money has no column default and rejects a negative value; an explicit value is stored as typed', async () => {
    await withTx(async (db) => {
      const s = await seed(db);
      const col = (await db.query(`select column_default, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'acquisition_contract_settings' and column_name = 'earnest_money_cents'`)).rows[0];
      expect(col.column_default).toBeNull();
      expect(col.is_nullable).toBe('YES');
      await db.query('savepoint n');
      const neg = await db.query(`insert into public.acquisition_contract_settings (org_id, earnest_money_cents) values ($1, -1)`, [s.orgA]).catch((e: PgError) => e);
      expect((neg as PgError).code).toBe('23514');
      await db.query('rollback to savepoint n');
      await db.query(`insert into public.acquisition_contract_settings (org_id, earnest_money_cents) values ($1, 777)`, [s.orgA]);
      expect(Number((await db.query(`select earnest_money_cents from public.acquisition_contract_settings`)).rows[0].earnest_money_cents)).toBe(777);
    });
  });

  it('RLS: any active member reads own-org rows only; only the org owner writes', async () => {
    await withTx(async (db) => {
      const s = await seed(db);
      const [titleA] = (await db.query(`insert into public.acquisition_contract_title_companies (org_id, name, closing_agent_name) values ($1, 'Sample Title A', 'Agent A') returning id`, [s.orgA])).rows;
      await db.query(`insert into public.acquisition_contract_title_companies (org_id, name, closing_agent_name) values ($1, 'Sample Title B', 'Agent B')`, [s.orgB]);
      await db.query(`insert into public.acquisition_contract_buyer_entities (org_id, name) values ($1, 'Sample Buyer A')`, [s.orgA]);

      await asUser(db, s.member);
      const seen = await db.query(`select org_id from public.acquisition_contract_title_companies`);
      expect(seen.rows.map((r) => r.org_id)).toEqual([s.orgA]);
      expect((await db.query(`select count(*)::int as n from public.acquisition_contract_buyer_entities`)).rows[0].n).toBe(1);

      // A non-owner member cannot write any table: RLS rejects insert, silently filters update and delete.
      await db.query('savepoint w');
      const ins = await db.query(`insert into public.acquisition_contract_title_companies (org_id, name, closing_agent_name) values ($1, 'x', 'y')`, [s.orgA]).catch((e: PgError) => e);
      expect((ins as PgError).code).toBe('42501');
      await db.query('rollback to savepoint w');
      const upd = await db.query(`update public.acquisition_contract_title_companies set name = 'hacked' where id = $1`, [titleA.id]);
      expect(upd.rowCount).toBe(0);
      const del = await db.query(`delete from public.acquisition_contract_title_companies where id = $1`, [titleA.id]);
      expect(del.rowCount).toBe(0);
      const sIns = await db.query(`insert into public.acquisition_contract_settings (org_id) values ($1)`, [s.orgA]).catch((e: PgError) => e);
      expect((sIns as PgError).code).toBe('42501');
      await db.query('rollback to savepoint w');

      // The owner writes in own org and is refused in another org.
      await asUser(db, s.owner);
      await db.query(`insert into public.acquisition_contract_settings (org_id) values ($1)`, [s.orgA]);
      const upd2 = await db.query(`update public.acquisition_contract_title_companies set name = 'Renamed' where id = $1`, [titleA.id]);
      expect(upd2.rowCount).toBe(1);
      await db.query('savepoint x');
      const cross = await db.query(`insert into public.acquisition_contract_title_companies (org_id, name, closing_agent_name) values ($1, 'x', 'y')`, [s.orgB]).catch((e: PgError) => e);
      expect((cross as PgError).code).toBe('42501');
      await db.query('rollback to savepoint x');

      // Anonymous has no access at all.
      await db.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true)`);
      await db.query('savepoint a');
      const anon = await db.query(`select * from public.acquisition_contract_title_companies`).catch((e: PgError) => e);
      expect((anon as PgError).code).toBe('42501');
      await db.query('rollback to savepoint a');
    });
  });

  it('composite FKs reject a default title company or market default from another org; market-default key treats null state once', async () => {
    await withTx(async (db) => {
      const s = await seed(db);
      const titleB = (await db.query(`insert into public.acquisition_contract_title_companies (org_id, name, closing_agent_name) values ($1, 'Sample Title B', 'Agent B') returning id`, [s.orgB])).rows[0].id;
      const titleA = (await db.query(`insert into public.acquisition_contract_title_companies (org_id, name, closing_agent_name) values ($1, 'Sample Title A', 'Agent A') returning id`, [s.orgA])).rows[0].id;
      await db.query('savepoint f');
      const fk1 = await db.query(`insert into public.acquisition_contract_settings (org_id, default_title_company_id) values ($1, $2)`, [s.orgA, titleB]).catch((e: PgError) => e);
      expect((fk1 as PgError).code).toBe('23503');
      await db.query('rollback to savepoint f');
      const fk2 = await db.query(`insert into public.acquisition_contract_title_market_defaults (org_id, market, title_company_id) values ($1, 'Dayton', $2)`, [s.orgA, titleB]).catch((e: PgError) => e);
      expect((fk2 as PgError).code).toBe('23503');
      await db.query('rollback to savepoint f');
      await db.query(`insert into public.acquisition_contract_title_market_defaults (org_id, market, title_company_id) values ($1, 'Dayton', $2)`, [s.orgA, titleA]);
      const dup = await db.query(`insert into public.acquisition_contract_title_market_defaults (org_id, market, title_company_id) values ($1, 'Dayton', $2)`, [s.orgA, titleA]).catch((e: PgError) => e);
      expect((dup as PgError).code).toBe('23505');
      await db.query('rollback to savepoint f');
      await db.query(`insert into public.acquisition_contract_title_market_defaults (org_id, market, state_code, title_company_id) values ($1, 'Dayton', 'OH', $2)`, [s.orgA, titleA]);
      const bad = await db.query(`insert into public.acquisition_contract_title_market_defaults (org_id, market, title_company_id) values ($1, 'Nowhere', $2)`, [s.orgA, titleA]).catch((e: PgError) => e);
      expect((bad as PgError).code).toBe('23514');
      await db.query('rollback to savepoint f');
    });
  });

  it('rollback twin applies cleanly: the four tables are gone and the earlier comps tables remain; reapplying works', async () => {
    await withTx(async (db) => {
      await asNone(db);
      await db.query(stripTransaction('rollbacks/20261007160000_acquisition_contract_defaults.sql'));
      for (const t of TABLES) {
        expect((await db.query(`select to_regclass($1) as r`, [`public.${t}`])).rows[0].r, t).toBeNull();
      }
      expect((await db.query(`select to_regclass('public.lead_comps') as r`)).rows[0].r).not.toBeNull();
      await applyMyLeadsChain(db, chainThrough('contractDefaults'));
      expect((await db.query(`select to_regclass('public.acquisition_contract_settings') as r`)).rows[0].r).not.toBeNull();
    });
  });
});
