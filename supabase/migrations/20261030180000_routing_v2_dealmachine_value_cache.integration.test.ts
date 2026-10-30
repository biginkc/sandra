import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * routing v2 PR-E DealMachine value cache (20261030180000). Local-only. The rollback and the
 * migration are re-applied first so both are exercised; test rows are created under a fresh
 * org and deleted at the end. The concurrency test uses 20 separate connections.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");
const MIGRATION = read("20261030180000_routing_v2_dealmachine_value_cache.sql");
const ROLLBACK = read("../rollbacks/20261030180000_routing_v2_dealmachine_value_cache.sql");

const db = new Client({ connectionString: url });
const pool = new Pool({ connectionString: url, max: 20 });
const orgId = randomUUID();
const otherOrgId = randomUUID();

async function newProperty(org = orgId): Promise<string> {
  const { rows } = await db.query(
    `insert into public.properties (org_id, address, state) values ($1, $2, 'MO') returning id`,
    [org, `${randomUUID().slice(0, 8)} Test St`],
  );
  return rows[0].id as string;
}

const claim = async (propertyId: string, client: Client | Pool = db, ttl = 60) =>
  (await client.query(`select * from public.fn_dealmachine_value_claim($1, $2, $3)`, [propertyId, orgId, ttl])).rows[0] as {
    outcome: string;
    claim_token: string | null;
    estimated_value: string | null;
  };

const settle = async (propertyId: string, token: string, state: string, value: number | null = null, retry: number | null = null) =>
  (await db.query(`select public.fn_dealmachine_value_settle($1, $2, $3, $4, $5, $6) as ok`, [propertyId, token, state, value, retry, null]))
    .rows[0].ok as boolean;

const age = (propertyId: string, col: "valid_until" | "retry_after" | "claim_expires_at") =>
  db.query(`update public.dealmachine_value_cache set ${col} = now() - interval '1 second' where property_id = $1`, [propertyId]);

beforeAll(async () => {
  await db.connect();
  await db.query(ROLLBACK);
  await db.query(MIGRATION);
  await db.query("insert into public.organizations (id, name) values ($1, 'routing-v2-pr-e'), ($2, 'routing-v2-pr-e-other')", [orgId, otherOrgId]);
});

afterAll(async () => {
  await db.query("delete from public.provider_spend_ledger where org_id in ($1, $2)", [orgId, otherOrgId]);
  await db.query("delete from public.properties where org_id in ($1, $2)", [orgId, otherOrgId]);
  await db.query("delete from public.organizations where id in ($1, $2)", [orgId, otherOrgId]);
  await pool.end();
  await db.end();
});

describe("dealmachine_value_cache claim", () => {
  it("20 concurrent claims for one property → exactly one winner", async () => {
    const p = await newProperty();
    const results = await Promise.all(Array.from({ length: 20 }, () => claim(p, pool)));
    expect(results.filter((r) => r.outcome === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "in_flight")).toHaveLength(19);
  });

  it("ok is cached 30 days (no new claim), then reclaimable", async () => {
    const p = await newProperty();
    const c = await claim(p);
    expect(await settle(p, c.claim_token!, "ok", 215000)).toBe(true);
    const again = await claim(p);
    expect(again.outcome).toBe("cached_ok");
    expect(Number(again.estimated_value)).toBe(215000);
    const { rows } = await db.query(
      `select valid_until > now() + interval '29 days' and valid_until <= now() + interval '30 days' as ok from public.dealmachine_value_cache where property_id = $1`,
      [p],
    );
    expect(rows[0].ok).toBe(true);
    await age(p, "valid_until");
    expect((await claim(p)).outcome).toBe("claimed");
  });

  it("negative cache blocks re-calls inside the window", async () => {
    const p = await newProperty();
    const c = await claim(p);
    expect(await settle(p, c.claim_token!, "negative")).toBe(true);
    expect((await claim(p)).outcome).toBe("cached_negative");
    await age(p, "valid_until");
    expect((await claim(p)).outcome).toBe("claimed");
  });

  it("failed_retryable is in backoff until retry_after", async () => {
    const p = await newProperty();
    const c = await claim(p);
    expect(await settle(p, c.claim_token!, "failed_retryable", null, 120)).toBe(true);
    expect((await claim(p)).outcome).toBe("backoff");
    await age(p, "retry_after");
    expect((await claim(p)).outcome).toBe("claimed");
  });

  it("crashed claim is reclaimable after expiry; the stale holder cannot settle", async () => {
    const p = await newProperty();
    const first = await claim(p);
    expect((await claim(p)).outcome).toBe("in_flight");
    await age(p, "claim_expires_at");
    const second = await claim(p);
    expect(second.outcome).toBe("claimed");
    expect(second.claim_token).not.toBe(first.claim_token);
    expect(await settle(p, first.claim_token!, "ok", 1)).toBe(false);
    expect(await settle(p, second.claim_token!, "ok", 2)).toBe(true);
    expect(Number((await claim(p)).estimated_value)).toBe(2);
  });

  it("rejects bad input: ok without value, wrong org, bad state", async () => {
    const p = await newProperty();
    const c = await claim(p);
    await expect(settle(p, c.claim_token!, "ok", null)).rejects.toThrow(/positive estimated_value/);
    await expect(settle(p, c.claim_token!, "in_flight")).rejects.toThrow(/invalid settle state/);
    const foreign = await newProperty(otherOrgId);
    await expect(claim(foreign)).rejects.toThrow(/property not in org/);
  });

  it("deleting the property removes its cache row", async () => {
    const p = await newProperty();
    await claim(p);
    await db.query("delete from public.properties where id = $1", [p]);
    const { rowCount } = await db.query("select 1 from public.dealmachine_value_cache where property_id = $1", [p]);
    expect(rowCount).toBe(0);
  });
});

describe("provider_spend_ledger: pre-call row + shared rate limit", () => {
  const start = async (propertyId: string | null, client: Client | Pool = db, org = orgId) =>
    (await client.query(`select public.fn_provider_attempt_start('dealmachine', $1, $2, 60) as id`, [org, propertyId])).rows[0].id as string | null;

  it("start writes attempt_started; settle is idempotent; an unsettled row is still counted", async () => {
    const p = await newProperty();
    const callId = await start(p);
    expect(callId).toBeTruthy();
    const row = async () => (await db.query("select status, cost, http_status from public.provider_spend_ledger where call_id = $1", [callId])).rows[0];
    expect(await row()).toEqual({ status: "attempt_started", cost: null, http_status: null });
    const settleIt = async () => (await db.query(`select public.fn_provider_attempt_settle($1, 200, 1) as ok`, [callId])).rows[0].ok;
    expect(await settleIt()).toBe(true);
    expect(await settleIt()).toBe(false);
    expect(await row()).toEqual({ status: "settled", cost: "1.0000", http_status: 200 });
  });

  it("61 concurrent attempts for different properties in one org → at most 60 slots (shared across connections)", async () => {
    const org = randomUUID();
    await db.query("insert into public.organizations (id, name) values ($1, 'routing-v2-pr-e-rate')", [org]);
    try {
      const props: string[] = [];
      for (let i = 0; i < 61; i++) props.push(await newProperty(org));
      const ids = await Promise.all(props.map((p) => start(p, pool, org)));
      expect(ids.filter(Boolean)).toHaveLength(60);
      expect(ids.filter((x) => x === null)).toHaveLength(1);
      const { rows } = await db.query("select count(*)::int as n from public.provider_spend_ledger where org_id = $1", [org]);
      expect(rows[0].n).toBe(60);
      // Unsettled rows still count; another org is not affected.
      expect(await start(null, db, org)).toBeNull();
      expect(await start(null)).toBeTruthy();
      // Rows older than a minute no longer count (rolling window).
      await db.query("update public.provider_spend_ledger set started_at = now() - interval '61 seconds' where org_id = $1", [org]);
      expect(await start(null, db, org)).toBeTruthy();
    } finally {
      await db.query("delete from public.provider_spend_ledger where org_id = $1", [org]);
      await db.query("delete from public.properties where org_id = $1", [org]);
      await db.query("delete from public.organizations where id = $1", [org]);
    }
  });

  it("rejects a property from another org and an out-of-range limit", async () => {
    const foreign = await newProperty(otherOrgId);
    await expect(start(foreign)).rejects.toThrow(/property not in org/);
    await expect(db.query(`select public.fn_provider_attempt_start('dealmachine', $1, null, 61)`, [orgId])).rejects.toThrow(/limit out of range/);
  });
});

describe("function security", () => {
  it("every RPC is SECURITY DEFINER with a pinned search_path", async () => {
    const { rows } = await db.query(
      `select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('fn_dealmachine_value_claim','fn_dealmachine_value_settle','fn_provider_attempt_start','fn_provider_attempt_settle')
        order by 1`,
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.prosecdef).toBe(true);
      expect(r.proconfig).toContain("search_path=public, pg_temp");
    }
  });
});

describe("grants", () => {
  it("anon/authenticated cannot read the tables or run the functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.query("begin");
      await db.query(`set local role ${role}`);
      await expect(db.query("select 1 from public.dealmachine_value_cache")).rejects.toThrow(/permission denied/);
      await db.query("rollback");
      await db.query("begin");
      await db.query(`set local role ${role}`);
      await expect(db.query("select 1 from public.provider_spend_ledger")).rejects.toThrow(/permission denied/);
      await db.query("rollback");
      await db.query("begin");
      await db.query(`set local role ${role}`);
      await expect(db.query(`select public.fn_dealmachine_value_claim($1, $2)`, [randomUUID(), orgId])).rejects.toThrow(/permission denied/);
      await db.query("rollback");
    }
  });

  it("service_role can read but not write the tables directly (writes go through the RPCs)", async () => {
    await db.query("begin");
    await db.query("set local role service_role");
    await db.query("select 1 from public.dealmachine_value_cache");
    await expect(db.query("delete from public.provider_spend_ledger")).rejects.toThrow(/permission denied/);
    await db.query("rollback");
  });

  it("service_role can claim", async () => {
    const p = await newProperty();
    await db.query("begin");
    await db.query("set local role service_role");
    const { rows } = await db.query(`select outcome from public.fn_dealmachine_value_claim($1, $2)`, [p, orgId]);
    await db.query("rollback");
    expect(rows[0].outcome).toBe("claimed");
  });
});

describe("rollback", () => {
  it("drops everything and re-applies cleanly", async () => {
    await db.query(ROLLBACK);
    const gone = await db.query(
      "select to_regclass('public.dealmachine_value_cache') as a, to_regclass('public.provider_spend_ledger') as b, to_regprocedure('public.fn_dealmachine_value_claim(uuid,uuid,integer)') as c, to_regprocedure('public.fn_provider_attempt_start(text,uuid,uuid,integer)') as d",
    );
    expect(gone.rows[0]).toEqual({ a: null, b: null, c: null, d: null });
    await db.query(MIGRATION);
    const back = await db.query("select to_regclass('public.dealmachine_value_cache') is not null as ok");
    expect(back.rows[0].ok).toBe(true);
  });
});
