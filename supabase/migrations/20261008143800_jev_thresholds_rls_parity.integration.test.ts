import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * Thresholds RLS parity (20261008143800). Local-only; each test runs in a
 * transaction that is rolled back. Requires a DB with the chain through
 * 20261008143700 applied.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261008143800_jev_thresholds_rls_parity.sql"), "utf8"));
const ROLLBACK = strip(
  readFileSync(path.join(__dirname, "../rollbacks/20261008143800_jev_thresholds_rls_parity.sql"), "utf8"),
);

const db = new Client({ connectionString: url });
let orgId: string;
const users = {} as Record<"owner" | "acq" | "plain", string>;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

async function addMember(key: keyof typeof users, role: "owner" | "member", acq = false) {
  const id = randomUUID();
  users[key] = id;
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${key}-${id}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status, acquisitions_enabled)
     values ($1, $2, $3, 'active', $4)`,
    [orgId, id, role, acq],
  );
}

beforeEach(async () => {
  await db.query("begin");
  orgId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, 'thr-rls')", [orgId]);
  await db.query("delete from public.jev_outcome_thresholds where org_id = $1", [orgId]);
  await db.query("set local session_replication_role = replica");
  await addMember("owner", "owner");
  await addMember("acq", "member", true);
  await addMember("plain", "member");
  await db.query("set local session_replication_role = origin");
  // Owner writes through the real RPC so a threshold + history row exist.
  await asUser(users.owner, () =>
    db.query(`select public.fn_set_jev_outcome_threshold($1, 'nurture', 0.9, 0, $2, null)`, [orgId, randomUUID()]),
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query("savepoint as_user");
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
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

const count = (table: string) => async () =>
  (await db.query(`select id from public.${table} where org_id = $1`, [orgId])).rows.length;

const TABLES = ["jev_outcome_thresholds", "jev_outcome_threshold_history"] as const;

describe("after migration", () => {
  beforeEach(async () => {
    await db.query(MIGRATION);
  });

  for (const table of TABLES) {
    it(`${table}: owner and acquisitions read, plain active member sees zero rows`, async () => {
      expect(await asUser(users.owner, count(table))).toBe(1);
      expect(await asUser(users.acq, count(table))).toBe(1);
      expect(await asUser(users.plain, count(table))).toBe(0);
    });

    it(`${table}: service_role still reads`, async () => {
      await db.query("savepoint s");
      await db.query("set local role service_role");
      try {
        if (table === "jev_outcome_thresholds") {
          expect((await db.query(`select id from public.${table} where org_id = $1`, [orgId])).rows).toHaveLength(1);
        } else {
          // History has no service_role grant by design (audit-only); RLS bypass must not change that.
          await expect(db.query(`select id from public.${table} where org_id = $1`, [orgId])).rejects.toThrow(
            /permission denied/,
          );
        }
      } finally {
        await db.query("rollback to savepoint s");
        await db.query("reset role");
      }
    });
  }

  it("messages-v2 page threshold query works for an acquisitions caller and is empty for a plain member", async () => {
    const q = () =>
      db.query(
        `select outcome, min_confidence, automation_enabled from public.jev_outcome_thresholds
          where org_id = $1 order by outcome asc`,
        [orgId],
      );
    const acq = await asUser(users.acq, q);
    expect(acq.rows).toHaveLength(1);
    expect(acq.rows[0].outcome).toBe("nurture");
    expect((await asUser(users.plain, q)).rows).toHaveLength(0);
  });

  it("owner-only write RPC is untouched: owner writes, acquisitions member is FORBIDDEN", async () => {
    await expect(
      asUser(users.acq, () =>
        db.query(`select public.fn_set_jev_outcome_threshold($1, 'nurture', 0.8, 1, $2, null)`, [orgId, randomUUID()]),
      ),
    ).rejects.toThrow(/FORBIDDEN/);
    await asUser(users.owner, () =>
      db.query(`select public.fn_set_jev_outcome_threshold($1, 'nurture', 0.8, 1, $2, null)`, [orgId, randomUUID()]),
    );
  });

  it("authenticated has no write grant on either table", async () => {
    await expect(
      asUser(users.owner, () =>
        db.query(`update public.jev_outcome_thresholds set min_confidence = 0.5 where org_id = $1`, [orgId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("policies use the uncorrelated readable-org-ids subquery", async () => {
    const r = await db.query(
      `select pg_get_expr(polqual, polrelid) q from pg_policy
        where polname in ('jev_outcome_thresholds_org_select','jev_outcome_threshold_history_org_select')`,
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) expect(row.q).toMatch(/pipeline_runs_readable_org_ids/);
  });

  it("rollback restores the previous any-active-member policies exactly", async () => {
    await db.query(ROLLBACK);
    const r = await db.query(
      `select polname, pg_get_expr(polqual, polrelid) q from pg_policy
        where polname in ('jev_outcome_thresholds_org_select','jev_outcome_threshold_history_org_select')`,
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) expect(row.q).toBe("hugo_has_active_org_access(org_id)");
    for (const table of TABLES) expect(await asUser(users.plain, count(table))).toBe(1);
  });
});

describe("before migration (baseline)", () => {
  it("plain active member could read both tables", async () => {
    for (const table of TABLES) expect(await asUser(users.plain, count(table))).toBe(1);
  });
});
