import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * Suppression recovery, database-truth (20261008144100). Local-only. Applies
 * the migration (idempotent create-or-replace) and exercises it on committed
 * rows so two real connections can race; rows are removed in afterEach.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261008144100_suppression_recovery_db_truth.sql"), "utf8"));
const ROLLBACK = strip(
  readFileSync(path.join(__dirname, "../rollbacks/20261008144100_suppression_recovery_db_truth.sql"), "utf8"),
);

const a = new Client({ connectionString: url });
const b = new Client({ connectionString: url });
let orgId: string;
let propertyId: string;
const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
const PTR = "suppression_incomplete:";

beforeAll(async () => {
  await a.connect();
  await b.connect();
  await a.query(MIGRATION);
});
afterAll(async () => {
  await a.query(MIGRATION).catch(() => undefined);
  await a.end();
  await b.end();
});

async function seed(reason: string | null) {
  orgId = randomUUID();
  propertyId = randomUUID();
  await a.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `ptr-truth-${orgId}`]);
  await a.query(
    `insert into public.properties (id, org_id, address, state, last_ai_escalation_reason, needs_human_attention)
     values ($1, $2, '1 Test St', 'MO', $3, $4)`,
    [propertyId, orgId, reason, reason !== null],
  );
}
afterEach(async () => {
  await a.query("rollback").catch(() => undefined);
  await b.query("rollback").catch(() => undefined);
  await a.query("delete from public.lead_events where org_id = $1", [orgId]);
  await a.query("delete from public.properties where org_id = $1", [orgId]);
  await a.query("delete from public.organizations where id = $1", [orgId]);
});

async function ledger(c: Client, id: string, kind: "failed" | "ok") {
  await c.query(
    `insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id)
     values ($1, $2, 'system', $3, '{}'::jsonb, $4, $5)`,
    [
      orgId,
      propertyId,
      kind === "failed" ? "suppression_incomplete" : "suppression_retried_ok",
      kind === "failed" ? "ai_disposition_reviews" : "ai_disposition_reviews.suppression_retried",
      id,
    ],
  );
}
const merge = (c: Client, list: string[], hint: string | null = null) =>
  c.query(
    `select reason, merged_ids, kept_timeout, dropped_ids
       from public.fn_merge_suppression_incomplete_pointer($1, $2::uuid[], p_hint_id => $3)`,
    [propertyId, list, hint],
  );
const clear = (c: Client) =>
  c.query("select cleared, outstanding_ids from public.fn_clear_suppression_hold_if_resolved($1)", [propertyId]);
const pointer = async () =>
  (await a.query("select last_ai_escalation_reason r, needs_human_attention n from public.properties where id=$1", [propertyId]))
    .rows[0];

describe("fn_merge_suppression_incomplete_pointer (database decides backed-ness)", () => {
  it("concurrent callers each merging one id: final pointer has both", async () => {
    const [x, y] = ids(2);
    await seed(null);
    await a.query("begin");
    await merge(a, [x]);
    const pending = merge(b, [y]);
    await new Promise((r) => setTimeout(r, 150));
    await a.query("commit");
    await pending;
    const p = await pointer();
    expect(p.r).toBe(`${PTR}${x},${y}`);
    expect(p.n).toBe(true);
  });

  it("many parallel callers never drop an id", async () => {
    const list = ids(6);
    await seed(null);
    const clients = [a, b];
    await Promise.all(list.map((id, i) => merge(clients[i % 2], [id])));
    const p = await pointer();
    expect(new Set(p.r.slice(PTR.length).split(","))).toEqual(new Set(list));
  });

  it("is idempotent and preserves existing order, appending new ids", async () => {
    const [x, y, z] = ids(3);
    await seed(`${PTR}${x},${y}`);
    expect((await merge(a, [z, x])).rows[0].reason).toBe(`${PTR}${x},${y},${z}`);
    expect((await merge(a, [z, x])).rows[0].reason).toBe(`${PTR}${x},${y},${z}`);
  });

  it("ten ledger-backed ids on the pointer + a new id whose ledger insert failed: the new id survives", async () => {
    const backed = ids(10);
    const [n] = ids(1);
    await seed(`${PTR}${backed.join(",")}`);
    for (const id of backed) await ledger(a, id, "failed");
    // The caller reports everything it knows; the DB alone decides backed-ness.
    const r = await merge(a, [n, ...backed]);
    expect(r.rows[0].merged_ids).toEqual([n]);
    expect(r.rows[0].dropped_ids).toEqual([]);
    expect((await pointer()).r).toBe(`${PTR}${n}`);
  });

  it("a caller that lies is irrelevant: ids with no ledger row stay even if reported with a hint", async () => {
    const [x, y, h] = ids(3);
    await seed(`${PTR}${x}`);
    await ledger(a, y, "failed");
    const r = await merge(a, [y], h);
    expect(r.rows[0].reason).toBe(`${PTR}${x}`);
  });

  it("ledger-backed existing ids are pruned; unbacked ones keep their order", async () => {
    const [x, y, z, u] = ids(4);
    await seed(`${PTR}${x},${y},${z}`);
    await ledger(a, y, "failed");
    const r = await merge(a, [u]);
    expect(r.rows[0].reason).toBe(`${PTR}${x},${z},${u}`);
  });

  it("the hint becomes the pointer only when everything else is ledger-backed", async () => {
    const [h] = ids(1);
    const old = ids(2);
    await seed(`${PTR}${old.join(",")}`);
    for (const id of old) await ledger(a, id, "failed");
    expect((await merge(a, old, h)).rows[0].reason).toBe(`${PTR}${h}`);
  });

  it("uses the hint over a non-pointer reason when nothing is unbacked", async () => {
    const [x] = ids(1);
    await seed("low_confidence");
    expect((await merge(a, [], x)).rows[0].reason).toBe(`${PTR}${x}`);
  });

  for (const reason of ["send_timeout:abc", "dead_letter_failed:send_timeout:abc"]) {
    it(`keeps ${reason} when every reported id is ledger-backed`, async () => {
      const [x] = ids(1);
      await seed(reason);
      await ledger(a, x, "failed");
      const r = await merge(a, [x], x);
      expect(r.rows[0].kept_timeout).toBe(true);
      const p = await pointer();
      expect(p.r).toBe(reason);
      expect(p.n).toBe(true);
    });

    it(`an id with no ledger row overrides ${reason}`, async () => {
      const [x] = ids(1);
      await seed(reason);
      const r = await merge(a, [x]);
      expect(r.rows[0].kept_timeout).toBe(false);
      expect((await pointer()).r).toBe(`${PTR}${x}`);
    });
  }

  it("caps at 10 oldest UNBACKED ids and returns the dropped ones", async () => {
    const old = ids(10);
    const [extra] = ids(1);
    await seed(`${PTR}${old.join(",")}`);
    const r = await merge(a, [extra]);
    expect(r.rows[0].merged_ids).toEqual(old);
    expect(r.rows[0].dropped_ids).toEqual([extra]);
  });

  it("cap alarm only when more than 10 unbacked ids exist", async () => {
    const un = ids(11);
    await seed(null);
    const r = await merge(a, un);
    expect(r.rows[0].merged_ids).toEqual(un.slice(0, 10));
    expect(r.rows[0].dropped_ids).toEqual([un[10]]);
  });

  it("the v2 signature (with p_backed_ids) no longer exists", async () => {
    await seed(null);
    await expect(
      a.query("select * from public.fn_merge_suppression_incomplete_pointer($1, $2::uuid[], $3::uuid[])", [propertyId, [], []]),
    ).rejects.toThrow(/does not exist|is not unique|invalid input|operator/);
    const n = await a.query(
      "select count(*)::int n from pg_proc where proname = 'fn_merge_suppression_incomplete_pointer' and 'p_backed_ids' = any(proargnames)",
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("raises for an unknown property", async () => {
    await seed(null);
    await expect(
      a.query("select * from public.fn_merge_suppression_incomplete_pointer($1, $2::uuid[])", [randomUUID(), []]),
    ).rejects.toThrow(/property not found/);
  });
});

describe("fn_clear_suppression_hold_if_resolved", () => {
  it("clears when the pointer ids are all retried_ok and nothing else is outstanding", async () => {
    const [x] = ids(1);
    await seed(`${PTR}${x}`);
    await ledger(a, x, "failed");
    await ledger(a, x, "ok");
    const r = await clear(a);
    expect(r.rows[0]).toEqual({ cleared: true, outstanding_ids: [] });
    expect(await pointer()).toEqual({ r: null, n: false });
  });

  it("clears a legacy bare hold with nothing recorded", async () => {
    await seed("suppression_incomplete");
    expect((await clear(a)).rows[0].cleared).toBe(true);
  });

  it("does not clear a pointer-only (unbacked) id", async () => {
    const [x] = ids(1);
    await seed(`${PTR}${x}`);
    const r = await clear(a);
    expect(r.rows[0]).toEqual({ cleared: false, outstanding_ids: [x] });
    expect((await pointer()).r).toBe(`${PTR}${x}`);
  });

  it("rewrites the pointer to the outstanding set (resolved dropped, ledger-only failure added)", async () => {
    const [x, y] = ids(2);
    await seed(`${PTR}${x}`);
    await ledger(a, x, "failed");
    await ledger(a, x, "ok");
    await ledger(a, y, "failed");
    const r = await clear(a);
    expect(r.rows[0]).toEqual({ cleared: false, outstanding_ids: [y] });
    const p = await pointer();
    expect(p).toEqual({ r: `${PTR}${y}`, n: true });
  });

  it("never clears or rewrites a preserved send-timeout hold", async () => {
    const [x] = ids(1);
    await seed("send_timeout:abc");
    await ledger(a, x, "failed");
    const r = await clear(a);
    expect(r.rows[0]).toEqual({ cleared: false, outstanding_ids: [x] });
    expect((await pointer()).r).toBe("send_timeout:abc");
    await a.query("delete from public.lead_events where org_id = $1", [orgId]);
    expect((await clear(a)).rows[0].cleared).toBe(false);
    expect((await pointer()).n).toBe(true);
  });

  it("race: the retry's clear waits on B's merge lock, then sees B outstanding and does not clear", async () => {
    const [A, B] = ids(2);
    await seed(`${PTR}${A}`);
    await ledger(a, A, "failed");
    await ledger(a, A, "ok"); // retry A already succeeded
    // B fails and its pointer merge holds the property row lock...
    await a.query("begin");
    await ledger(a, B, "failed");
    await merge(a, [B]);
    // ...the retry's clear (connection b) must queue behind it.
    let settled = false;
    const pending = clear(b).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(settled).toBe(false);
    await a.query("commit");
    const r = await pending;
    expect(r.rows[0]).toEqual({ cleared: false, outstanding_ids: [B] });
    expect(await pointer()).toEqual({ r: `${PTR}${B}`, n: true });
  });

  it("raises for an unknown property", async () => {
    await seed(null);
    await expect(a.query("select * from public.fn_clear_suppression_hold_if_resolved($1)", [randomUUID()])).rejects.toThrow(
      /property not found/,
    );
  });
});

describe("privileges and rollback", () => {
  it("authenticated and anon cannot execute either function; service_role can", async () => {
    await seed(null);
    const [x] = ids(1);
    for (const role of ["authenticated", "anon"]) {
      for (const run of [() => merge(a, [x]), () => clear(a)]) {
        await a.query("begin");
        await a.query(`set local role ${role}`);
        await expect(run()).rejects.toThrow(/permission denied/);
        await a.query("rollback");
      }
    }
    await a.query("begin");
    await a.query("set local role service_role");
    await merge(a, [x]);
    await clear(a);
    await a.query("rollback");
  });

  it("rollback drops the DB-truth functions and restores v2 (with p_backed_ids)", async () => {
    await seed(null);
    await a.query(ROLLBACK);
    try {
      await expect(clear(a)).rejects.toThrow(/does not exist/);
      await expect(merge(a, [])).rejects.toThrow(/does not exist|is not unique/);
      const v2 = await a.query(
        "select * from public.fn_merge_suppression_incomplete_pointer($1, $2::uuid[], $3::uuid[])",
        [propertyId, [], []],
      );
      expect(v2.rowCount).toBe(1);
    } finally {
      await a.query(MIGRATION);
    }
  });
});
