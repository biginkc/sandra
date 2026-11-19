import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const sql = (name: string, dir = __dirname) => readFileSync(path.join(dir, name), "utf8").replace(/^\s*(begin|commit);\s*$/gim, "");
const M = "20261031131200_routing_v2_model_spend_ledger.sql";
let org: string;

beforeAll(() => db.connect());
afterAll(() => db.end());
beforeEach(async () => {
  await db.query("begin");
  await db.query(sql(M));
  org = randomUUID();
  await db.query("insert into organizations(id,name) values($1,'spend test')", [org]);
});
afterEach(() => db.query("rollback"));

const record = (provider: string, tin: number | null, tout: number | null, cost: number | null) =>
  db.query("select fn_record_model_call($1,$2,null,null,'decided',$3,$4,$5,'usd') as id", [provider, org, tin, tout, cost]);

describe("Jev / Haiku spend ledger (A-6)", () => {
  it("one settled row per call with tokens; no cap", async () => {
    for (let i = 0; i < 70; i++) await record("jev", 1100, 520, null); // over the DealMachine 60/min limit: never refused
    await record("haiku", 900, 20, 0.0001);
    const { rows } = await db.query("select provider, count(*)::int n, sum(input_tokens)::int tin, bool_and(status='settled') s from provider_spend_ledger where org_id=$1 group by provider order by provider", [org]);
    expect(rows).toEqual([{ provider: "haiku", n: 1, tin: 900, s: true }, { provider: "jev", n: 70, tin: 77000, s: true }]);
  });
  it("only jev / haiku through this function; service role only; rollback restores the DealMachine-only check", async () => {
    await db.query("savepoint s");
    await expect(record("dealmachine", 1, 1, 1)).rejects.toThrow(/unsupported model provider/);
    await db.query("rollback to savepoint s");
    expect((await db.query("select has_function_privilege('authenticated','fn_record_model_call(text,uuid,uuid,uuid,text,integer,integer,numeric,text)','EXECUTE') u")).rows[0].u).toBe(false);
    await db.query(sql(M));
    await record("jev", 1, 1, null);
    await db.query(sql("20261031131200_routing_v2_model_spend_ledger.sql", path.join(__dirname, "../rollbacks")));
    expect((await db.query("select count(*)::int n from provider_spend_ledger where provider in ('jev','haiku')")).rows[0].n).toBe(0);
    expect((await db.query("select to_regproc('public.fn_record_model_call') f")).rows[0].f).toBeNull();
  });
});
