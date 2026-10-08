import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * Q5 thresholds (20261008143700). Local-only; every test runs in a
 * transaction that is rolled back.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261008143700_jev_thresholds_q5.sql"), "utf8"));
const ROLLBACK = strip(
  readFileSync(path.join(__dirname, "../rollbacks/20261008143700_jev_thresholds_q5.sql"), "utf8"),
);

async function withDb(fn: (db: Client, org: string) => Promise<void>) {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    const org = randomUUID();
    await db.query("insert into public.organizations(id,name) values ($1,'q5')", [org]);
    // Seed exactly as production holds it before this migration.
    await db.query("delete from public.jev_outcome_thresholds where org_id=$1", [org]);
    for (const [o, c, ae] of [
      ["new_lead", 0.9, false],
      ["wrong_number", 0.9, true],
      ["not_interested", 0.95, true],
      ["nurture", 0.95, true],
      ["opted_out", 0.95, true],
    ] as const) {
      const id = (
        await db.query<{ id: string }>(
          "insert into public.jev_outcome_thresholds(org_id,outcome,min_confidence,version,updated_by,automation_enabled) values ($1,$2,$3,1,null,$4) returning id",
          [org, o, c, ae],
        )
      ).rows[0]!.id;
      await db.query(
        "insert into public.jev_outcome_threshold_history(threshold_id,org_id,outcome,previous_min_confidence,new_min_confidence,version,changed_by,new_automation_enabled) values ($1,$2,$3,null,$4,1,null,$5)",
        [id, org, o, c, ae],
      );
    }
    await fn(db, org);
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}

async function table(db: Client, org: string) {
  const r = await db.query<{ outcome: string; c: string; v: number; a: boolean }>(
    "select outcome, min_confidence::text c, version v, automation_enabled a from public.jev_outcome_thresholds where org_id=$1 order by outcome",
    [org],
  );
  return Object.fromEntries(r.rows.map((x) => [x.outcome, { c: x.c, v: x.v, a: x.a }]));
}
const histCount = async (db: Client, org: string) =>
  Number((await db.query("select count(*) n from public.jev_outcome_threshold_history where org_id=$1", [org])).rows[0].n);

describe("jev thresholds Q5", () => {
  it("moves seeded not_interested to 0.90 and leaves every other outcome alone", async () => {
    await withDb(async (db, org) => {
      await db.query(MIGRATION);
      expect(await table(db, org)).toEqual({
        new_lead: { c: "0.900", v: 1, a: false },
        wrong_number: { c: "0.900", v: 1, a: true },
        not_interested: { c: "0.900", v: 2, a: true },
        nurture: { c: "0.950", v: 1, a: true },
        opted_out: { c: "0.950", v: 1, a: true },
      });
      const h = await db.query(
        "select previous_min_confidence::text p, new_min_confidence::text n, version, changed_by, new_automation_enabled from public.jev_outcome_threshold_history where org_id=$1 and outcome='not_interested' and version=2",
        [org],
      );
      expect(h.rows).toEqual([{ p: "0.950", n: "0.900", version: 2, changed_by: null, new_automation_enabled: true }]);
    });
  });

  it("does not override an owner-set value (0.92), nor an owner who re-saved 0.95", async () => {
    await withDb(async (db, org) => {
      await db.query(
        "update public.jev_outcome_thresholds set min_confidence=0.92, version=2 where org_id=$1 and outcome='not_interested'",
        [org],
      );
      const before = await histCount(db, org);
      await db.query(MIGRATION);
      expect((await table(db, org)).not_interested).toEqual({ c: "0.920", v: 2, a: true });
      expect(await histCount(db, org)).toBe(before);
      await db.query("update public.jev_outcome_thresholds set min_confidence=0.95, version=3 where org_id=$1 and outcome='not_interested'", [org]);
      await db.query(MIGRATION);
      expect((await table(db, org)).not_interested).toEqual({ c: "0.950", v: 3, a: true });
    });
  });

  it("re-run is a no-op", async () => {
    await withDb(async (db, org) => {
      await db.query(MIGRATION);
      const t = await table(db, org);
      const n = await histCount(db, org);
      await db.query(MIGRATION);
      expect(await table(db, org)).toEqual(t);
      expect(await histCount(db, org)).toBe(n);
    });
  });

  it("fresh orgs after reset_tenant_tables get 0.90", async () => {
    await withDb(async (db, org) => {
      await db.query(MIGRATION);
      await db.query("delete from public.jev_outcome_thresholds where org_id=$1", [org]);
      const def = (await db.query<{ d: string }>("select pg_get_functiondef('public.reset_tenant_tables()'::regprocedure) d")).rows[0]!.d;
      expect(def).toContain("('not_interested', 0.90)");
      expect(def).not.toContain("('not_interested', 0.95)");
      expect(def).toContain("('nurture', 0.95)");
      expect(def).toContain("('opted_out', 0.95)");
    });
  });

  it("rollback restores 0.95 only where this migration set it", async () => {
    await withDb(async (db, org) => {
      await db.query(MIGRATION);
      await db.query(ROLLBACK);
      expect((await table(db, org)).not_interested).toEqual({ c: "0.950", v: 3, a: true });
      const def = (await db.query<{ d: string }>("select pg_get_functiondef('public.reset_tenant_tables()'::regprocedure) d")).rows[0]!.d;
      expect(def).toContain("('not_interested', 0.95)");
    });
    await withDb(async (db, org) => {
      await db.query(MIGRATION);
      await db.query(
        "update public.jev_outcome_thresholds set min_confidence=0.92, version=3 where org_id=$1 and outcome='not_interested'",
        [org],
      );
      await db.query(ROLLBACK);
      expect((await table(db, org)).not_interested).toEqual({ c: "0.920", v: 3, a: true });
    });
  });
});
