import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * 20261008280000: opted_out can never be automated (Jarrad 2026-10-07).
 * Local-only; each test runs in a rolled-back transaction on a DB with the
 * chain through 20261008230000 applied.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261008280000_jev_opted_out_human_only.sql"), "utf8"));
const ROLLBACK = strip(
  readFileSync(path.join(__dirname, "../rollbacks/20261008280000_jev_opted_out_human_only.sql"), "utf8"),
);

const db = new Client({ connectionString: url });
let orgId: string;
let ownerId: string;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await db.query("begin");
  orgId = randomUUID();
  ownerId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, 'opt-human')", [orgId]);
  await db.query("delete from public.jev_outcome_thresholds where org_id = $1", [orgId]);
  await db.query("set local session_replication_role = replica");
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [ownerId, `owner-${ownerId}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`,
    [orgId, ownerId],
  );
  await db.query("set local session_replication_role = origin");
});
afterEach(async () => {
  await db.query("rollback");
});

async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  await db.query("savepoint as_user");
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [ownerId]);
  try {
    const out = await fn();
    await db.query("reset role");
    await db.query("release savepoint as_user");
    return out;
  } catch (e) {
    await db.query("rollback to savepoint as_user");
    await db.query("reset role");
    throw e;
  }
}

const setThreshold = (outcome: string, expectedVersion: number, automation: boolean | null) =>
  asOwner(() =>
    db.query(`select public.fn_set_jev_outcome_threshold($1, $2, 0.9, $3, $4, $5)`, [
      orgId,
      outcome,
      expectedVersion,
      randomUUID(),
      automation,
    ]),
  );

describe("20261008280000", () => {
  it("forces an existing opted_out row that has automation on back to off, with a history row", async () => {
    // Simulate the pre-migration state (the scratch DB may already carry the constraint).
    await db.query(`alter table public.jev_outcome_thresholds drop constraint if exists jev_outcome_thresholds_opted_out_human_only`);
    await db.query(
      `insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled, version)
       values ($1, 'opted_out', 0.95, true, 1)`,
      [orgId],
    );
    await db.query(MIGRATION);
    const row = (
      await db.query(
        `select automation_enabled, version from public.jev_outcome_thresholds where org_id = $1 and outcome = 'opted_out'`,
        [orgId],
      )
    ).rows[0];
    expect(row).toEqual({ automation_enabled: false, version: 2 });
    const history = (
      await db.query(
        `select previous_automation_enabled, new_automation_enabled from public.jev_outcome_threshold_history
         where org_id = $1 and outcome = 'opted_out'`,
        [orgId],
      )
    ).rows;
    expect(history).toEqual([{ previous_automation_enabled: true, new_automation_enabled: false }]);
  });

  it("the CHECK constraint stops any writer from turning opted_out automation on", async () => {
    await db.query(MIGRATION);
    await expect(
      db.query(
        `insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled, version)
         values ($1, 'opted_out', 0.95, true, 1)`,
        [orgId],
      ),
    ).rejects.toThrow(/jev_outcome_thresholds_opted_out_human_only/);
  });

  it("fn_set_jev_outcome_threshold refuses automation = true for opted_out but allows it for wrong_number", async () => {
    await db.query(MIGRATION);
    await expect(setThreshold("opted_out", 0, true)).rejects.toThrow(/HUMAN_ONLY_OUTCOME/);
    await setThreshold("wrong_number", 0, true);
    const wn = (
      await db.query(
        `select automation_enabled from public.jev_outcome_thresholds where org_id = $1 and outcome = 'wrong_number'`,
        [orgId],
      )
    ).rows[0];
    expect(wn.automation_enabled).toBe(true);
  });

  it("opted_out stays off when created with the default (null) or explicitly false", async () => {
    await db.query(MIGRATION);
    await setThreshold("opted_out", 0, null);
    const created = (
      await db.query(
        `select automation_enabled from public.jev_outcome_thresholds where org_id = $1 and outcome = 'opted_out'`,
        [orgId],
      )
    ).rows[0];
    expect(created.automation_enabled).toBe(false);
    await setThreshold("opted_out", 1, false);
  });

  it("rollback drops the constraint", async () => {
    await db.query(MIGRATION);
    await db.query(ROLLBACK);
    await expect(
      db.query(
        `insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled, version)
         values ($1, 'opted_out', 0.95, true, 1)`,
        [orgId],
      ),
    ).resolves.toBeDefined();
  });
});
