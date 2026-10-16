import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * Suppression ledger rule (20261008144200): an id is resolved whenever a
 * suppression_retried_ok row exists, regardless of created_at order; the merge
 * function prunes resolved ids like the clear function does. Local-only.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const read = (rel: string) => strip(readFileSync(path.join(__dirname, rel), "utf8"));
const BASE = read("20261008144100_suppression_recovery_db_truth.sql");
const MIGRATION = read("20261008144200_suppression_ledger_rule.sql");
const ROLLBACK = read("../rollbacks/20261008144200_suppression_ledger_rule.sql");

const a = new Client({ connectionString: url });
let orgId: string;
let propertyId: string;
const PTR = "suppression_incomplete:";

beforeAll(async () => {
  await a.connect();
  await a.query(BASE);
  await a.query(MIGRATION);
});
afterAll(async () => {
  await a.query(BASE).catch(() => undefined);
  await a.query(MIGRATION).catch(() => undefined);
  await a.end();
});

async function seed(reason: string | null) {
  orgId = randomUUID();
  propertyId = randomUUID();
  await a.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `ledger-rule-${orgId}`]);
  await a.query(
    `insert into public.properties (id, org_id, address, state, last_ai_escalation_reason, needs_human_attention)
     values ($1, $2, '1 Test St', 'MO', $3, $4)`,
    [propertyId, orgId, reason, reason !== null],
  );
}
afterEach(async () => {
  await a.query("rollback").catch(() => undefined);
  await a.query("delete from public.lead_events where org_id = $1", [orgId]);
  await a.query("delete from public.properties where org_id = $1", [orgId]);
  await a.query("delete from public.organizations where id = $1", [orgId]);
});

// `at` offsets created_at (seconds from now) so tests control row order.
async function ledger(id: string, kind: "failed" | "ok", at = 0) {
  await a.query(
    `insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id, created_at)
     values ($1, $2, 'system', $3, '{}'::jsonb, $4, $5, now() + ($6 || ' seconds')::interval)`,
    [
      orgId,
      propertyId,
      kind === "failed" ? "suppression_incomplete" : "suppression_retried_ok",
      kind === "failed" ? "ai_disposition_reviews" : "ai_disposition_reviews.suppression_retried",
      id,
      String(at),
    ],
  );
}
const state = async () =>
  (await a.query("select review_id, ledger_failed, resolved from public.fn_suppression_ledger_state($1)", [propertyId])).rows;
const merge = (list: string[]) =>
  a.query(
    "select reason, merged_ids, dropped_ids from public.fn_merge_suppression_incomplete_pointer($1, $2::uuid[])",
    [propertyId, list],
  );
const clear = () => a.query("select cleared, outstanding_ids from public.fn_clear_suppression_hold_if_resolved($1)", [propertyId]);
const pointer = async () =>
  (await a.query("select last_ai_escalation_reason r, needs_human_attention n from public.properties where id=$1", [propertyId]))
    .rows[0];

describe("ledger rule: resolved whenever a retried_ok row exists", () => {
  it("failure backfilled AFTER retried_ok: state says resolved", async () => {
    const x = randomUUID();
    await seed(null);
    await ledger(x, "ok", 0);
    await ledger(x, "failed", 5);
    expect(await state()).toEqual([{ review_id: x, ledger_failed: true, resolved: true }]);
  });

  it("failure before retried_ok is still resolved", async () => {
    const x = randomUUID();
    await seed(null);
    await ledger(x, "failed", 0);
    await ledger(x, "ok", 5);
    expect((await state())[0]).toMatchObject({ ledger_failed: true, resolved: true });
  });

  it("failure only: unresolved; retried_ok only: resolved without a failure row", async () => {
    const [x, y] = [randomUUID(), randomUUID()];
    await seed(null);
    await ledger(x, "failed");
    await ledger(y, "ok");
    const rows = Object.fromEntries((await state()).map((r) => [r.review_id, r]));
    expect(rows[x]).toMatchObject({ ledger_failed: true, resolved: false });
    expect(rows[y]).toMatchObject({ ledger_failed: false, resolved: true });
  });

  it("clear: backfill-after-retried_ok id does not hold the property", async () => {
    const x = randomUUID();
    await seed(`${PTR}${x}`);
    await ledger(x, "ok", 0);
    await ledger(x, "failed", 5);
    expect((await clear()).rows[0]).toEqual({ cleared: true, outstanding_ids: [] });
    expect(await pointer()).toEqual({ r: null, n: false });
  });

  it("merge: prunes a resolved id from the pointer (backfill-after-retried_ok) and keeps a truly unbacked one", async () => {
    const [x, y] = [randomUUID(), randomUUID()];
    await seed(`${PTR}${x},${y}`);
    await ledger(x, "ok", 0);
    await ledger(x, "failed", 5);
    const r = (await merge([])).rows[0];
    expect(r.merged_ids).toEqual([y]);
    expect(r.reason).toBe(`${PTR}${y}`);
  });

  it("merge: a resolved id passed by the caller is not re-added", async () => {
    const [x, y] = [randomUUID(), randomUUID()];
    await seed(null);
    await ledger(x, "ok");
    const r = (await merge([x, y])).rows[0];
    expect(r.merged_ids).toEqual([y]);
  });

  it("merge: a live-failure (unresolved, backed) id is still kept off the pointer", async () => {
    const [x, y] = [randomUUID(), randomUUID()];
    await seed(`${PTR}${x}`);
    await ledger(x, "failed");
    const r = (await merge([y])).rows[0];
    expect(r.merged_ids).toEqual([y]);
  });
});

describe("privileges and rollback", () => {
  it("authenticated and anon cannot execute fn_suppression_ledger_state; service_role can", async () => {
    await seed(null);
    for (const role of ["authenticated", "anon"]) {
      await a.query("begin");
      await a.query(`set local role ${role}`);
      await expect(state()).rejects.toThrow(/permission denied/);
      await a.query("rollback");
    }
    await a.query("begin");
    await a.query("set local role service_role");
    await state();
    await a.query("rollback");
  });

  it("rollback restores the timestamp-ordered rule", async () => {
    const x = randomUUID();
    await seed(null);
    await ledger(x, "ok", 0);
    await ledger(x, "failed", 5);
    await a.query(ROLLBACK);
    try {
      expect((await state())[0]).toMatchObject({ resolved: false });
    } finally {
      await a.query(MIGRATION);
    }
    expect((await state())[0]).toMatchObject({ resolved: true });
  });
});
