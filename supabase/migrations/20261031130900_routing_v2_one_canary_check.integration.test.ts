import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { isV2Eligible, parseRoutingV2Flags } from "@/lib/sms-classification/routing-v2/flags";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const strip = (s: string) => s.replace(/^\s*(begin|commit);\s*$/gim, "");
const read = (...p: string[]) => strip(readFileSync(path.join(__dirname, ...p), "utf8"));
const M = read("20261031130900_routing_v2_one_canary_check.sql");
const ROLLBACK = read("..", "rollbacks", "20261031130900_routing_v2_one_canary_check.sql");

const ids = Array.from({ length: 300 }, () => randomUUID());
const fixed = "0b8f3c1e-6a2b-4c3d-8e4f-5a6b7c8d9e0f";
const configs: unknown[] = [
  {}, { canary_percent: 0 }, { canary_percent: 10 }, { canary_percent: 50 }, { canary_percent: 100 },
  { canary_property_ids: [fixed] }, { canary_property_ids: [fixed.toUpperCase()], canary_percent: 5 },
  { canary_property_ids: "nope" }, { canary_property_ids: [fixed, "bad"] }, { canary_property_ids: [1] },
  { canary_percent: 10.5 }, { canary_percent: -1 }, { canary_percent: 101 }, { canary_percent: "10" }, [],
];

beforeAll(() => db.connect());
afterAll(() => db.end());
beforeEach(() => db.query("begin"));
afterEach(() => db.query("rollback"));

async function matrix(): Promise<boolean[][]> {
  const out: boolean[][] = [];
  for (const cfg of configs) {
    const { rows } = await db.query(
      `select public.routing_v2_canary_eligible($1::jsonb, id) a, public.fn_routing_v2_property_eligible($1::jsonb, id) b, public.routing_v2_phone_action_eligible($1::jsonb, id) c
       from unnest($2::uuid[]) id`,
      [JSON.stringify(cfg), [...ids, fixed]],
    );
    out.push(rows.flatMap((r) => [r.a, r.b, r.c]));
  }
  return out;
}

describe("one canary check", () => {
  it("the old three copies agree; after the merge all three still agree, with TS isV2Eligible too", async () => {
    await db.query(ROLLBACK); // the pre-merge bodies
    const before = await matrix();
    await db.query(M);
    const after = await matrix();
    expect(after).toEqual(before);
    for (const [i, cfg] of configs.entries()) {
      const flags = parseRoutingV2Flags(cfg);
      const ts = [...ids, fixed].flatMap((id) => { const e = isV2Eligible(flags, id); return [e, e, e]; });
      expect(after[i], JSON.stringify(cfg)).toEqual(ts);
    }
  });
  it("the two delegates have no logic of their own; rollback restores the old bodies", async () => {
    await db.query(M);
    for (const fn of ["fn_routing_v2_property_eligible", "routing_v2_phone_action_eligible"]) {
      const src = (await db.query("select prosrc from pg_proc where proname = $1", [fn])).rows[0].prosrc as string;
      expect(src.trim()).toBe("select public.routing_v2_canary_eligible(p_flags, p_property_id);");
    }
    await db.query(ROLLBACK);
    const src = (await db.query("select prosrc from pg_proc where proname = 'routing_v2_phone_action_eligible'")).rows[0].prosrc as string;
    expect(readFileSync(path.join(__dirname, "20261030250000_routing_v2_wrong_number_all.sql"), "utf8")).toContain(src);
    expect((await db.query("select has_function_privilege('authenticated','fn_routing_v2_property_eligible(jsonb,uuid)','EXECUTE') as u")).rows[0].u).toBe(false);
  });
});
