import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * 20261111120000 land signal. Local-only. Rollback + migration re-applied first. Covers: only the
 * current claim holder records a shape, a stale writer changes nothing, and every new claim wipes
 * the previous shape (failed shape write / old code → unknown, never an older land answer).
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");
const MIGRATION = read("20261111120000_dealmachine_value_cache_land_signal.sql");
const ROLLBACK = read("../rollbacks/20261111120000_dealmachine_value_cache_land_signal.sql");

const db = new Client({ connectionString: url });
const orgId = randomUUID();
let propertyId = "";

const claim = async () =>
  (await db.query(`select claim_token from public.fn_dealmachine_value_claim($1, $2)`, [propertyId, orgId])).rows[0].claim_token as string;
const record = async (token: string, isLand: boolean) =>
  (await db.query(`select public.fn_dealmachine_value_record_shape($1, $2, 0, 0, $3) as ok`, [propertyId, token, isLand])).rows[0].ok as boolean;
const settleOk = (token: string, v: number) =>
  db.query(`select public.fn_dealmachine_value_settle($1, $2, 'ok', $3)`, [propertyId, token, v]);
const row = async () => (await db.query(`select state, is_land from public.dealmachine_value_cache where property_id = $1`, [propertyId])).rows[0];

beforeAll(async () => {
  await db.connect();
  await db.query(ROLLBACK);
  await db.query(MIGRATION);
  await db.query("insert into public.organizations (id, name) values ($1, 'land-signal')", [orgId]);
  propertyId = (await db.query(`insert into public.properties (org_id, address, state) values ($1, '200 NW 81st St', 'MO') returning id`, [orgId])).rows[0].id;
});

afterAll(async () => {
  await db.query("delete from public.provider_spend_ledger where org_id = $1", [orgId]);
  await db.query("delete from public.properties where org_id = $1", [orgId]);
  await db.query("delete from public.organizations where id = $1", [orgId]);
  await db.end();
});

describe("dealmachine_value_cache land signal", () => {
  it("claim holder records land; a stale token does not", async () => {
    const t1 = await claim();
    expect(await record(randomUUID(), false)).toBe(false);
    expect(await record(t1, true)).toBe(true);
    await settleOk(t1, 231000);
    expect(await row()).toEqual({ state: "ok", is_land: true });
  });

  it("a new claim wipes the old shape: a refresh with no shape write settles unknown", async () => {
    await db.query(`update public.dealmachine_value_cache set valid_until = now() - interval '1 second' where property_id = $1`, [propertyId]);
    const t2 = await claim();
    await settleOk(t2, 250000);
    expect(await row()).toEqual({ state: "ok", is_land: null });
  });
});
