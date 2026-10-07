import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * Atomic suppression pointer merge v2 (20261008144000). Local-only. Applies the
 * migration (idempotent create-or-replace) and exercises it on committed rows
 * so two real connections can race; rows are removed in afterEach.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261008144000_suppression_pointer_union_v2.sql"), "utf8"));
const ROLLBACK = strip(
  readFileSync(path.join(__dirname, "../rollbacks/20261008144000_suppression_pointer_union_v2.sql"), "utf8"),
);

const a = new Client({ connectionString: url });
const b = new Client({ connectionString: url });
let orgId: string;
let propertyId: string;
const ids = (n: number) => Array.from({ length: n }, () => randomUUID());

beforeAll(async () => {
  await a.connect();
  await b.connect();
  await a.query(MIGRATION);
});
afterAll(async () => {
  await a.end();
  await b.end();
});

async function seed(reason: string | null) {
  orgId = randomUUID();
  propertyId = randomUUID();
  await a.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `ptr-union-${orgId}`]);
  await a.query(
    `insert into public.properties (id, org_id, address, state, last_ai_escalation_reason, needs_human_attention)
     values ($1, $2, '1 Test St', 'MO', $3, false)`,
    [propertyId, orgId, reason],
  );
}
afterEach(async () => {
  await a.query("rollback").catch(() => undefined);
  await a.query("delete from public.properties where org_id = $1", [orgId]);
  await a.query("delete from public.organizations where id = $1", [orgId]);
});

const merge = (c: Client, list: string[], hint: string | null = null, backed: string[] = []) =>
  c.query(
    `select reason, merged_ids, kept_timeout, dropped_ids
       from public.fn_merge_suppression_incomplete_pointer($1, $2::uuid[], $3::uuid[], p_hint_id => $4)`,
    [propertyId, list, backed, hint],
  );
const pointer = async () =>
  (await a.query("select last_ai_escalation_reason r, needs_human_attention n from public.properties where id=$1", [propertyId]))
    .rows[0];

describe("fn_merge_suppression_incomplete_pointer", () => {
  it("concurrent callers each merging one id: final pointer has both", async () => {
    const [x, y] = ids(2);
    await seed(null);
    // Hold the row lock from connection A so B's call must queue behind it.
    await a.query("begin");
    await merge(a, [x]);
    const pending = merge(b, [y]);
    await new Promise((r) => setTimeout(r, 150));
    await a.query("commit");
    await pending;
    const p = await pointer();
    expect(p.r).toBe(`suppression_incomplete:${x},${y}`);
    expect(p.n).toBe(true);
  });

  it("many parallel callers never drop an id", async () => {
    const list = ids(6);
    await seed(null);
    const clients = [a, b];
    await Promise.all(list.map((id, i) => merge(clients[i % 2], [id])));
    const p = await pointer();
    expect(new Set(p.r.slice("suppression_incomplete:".length).split(","))).toEqual(new Set(list));
  });

  it("is idempotent and preserves existing order, appending new ids", async () => {
    const [x, y, z] = ids(3);
    await seed(`suppression_incomplete:${x},${y}`);
    const r1 = await merge(a, [z, x]);
    expect(r1.rows[0].reason).toBe(`suppression_incomplete:${x},${y},${z}`);
    const r2 = await merge(a, [z, x]);
    expect(r2.rows[0].reason).toBe(`suppression_incomplete:${x},${y},${z}`);
  });

  it("uses the hint when nothing is unbacked, over a non-pointer reason", async () => {
    const [x] = ids(1);
    await seed("low_confidence");
    const r = await merge(a, [], x);
    expect(r.rows[0].reason).toBe(`suppression_incomplete:${x}`);
  });

  for (const reason of ["send_timeout:abc", "dead_letter_failed:send_timeout:abc"]) {
    it(`keeps ${reason} and only raises the hold when no ids are unbacked`, async () => {
      const [x] = ids(1);
      await seed(reason);
      const r = await merge(a, [], x);
      expect(r.rows[0].kept_timeout).toBe(true);
      const p = await pointer();
      expect(p.r).toBe(reason);
      expect(p.n).toBe(true);
    });

    it(`unbacked ids override ${reason} (they exist nowhere else)`, async () => {
      const [x] = ids(1);
      await seed(reason);
      const r = await merge(a, [x]);
      expect(r.rows[0].kept_timeout).toBe(false);
      expect((await pointer()).r).toBe(`suppression_incomplete:${x}`);
    });
  }

  it("caps at 10 oldest and returns the dropped ids", async () => {
    const old = ids(10);
    const [extra] = ids(1);
    await seed(`suppression_incomplete:${old.join(",")}`);
    const r = await merge(a, [extra]);
    expect(r.rows[0].merged_ids).toEqual(old);
    expect(r.rows[0].dropped_ids).toEqual([extra]);
    expect((await pointer()).r).toBe(`suppression_incomplete:${old.join(",")}`);
  });

  it("ten backed ids then one unbacked: the unbacked id survives, no cap alarm", async () => {
    const backed = ids(10);
    const [u] = ids(1);
    await seed(`suppression_incomplete:${backed.join(",")}`);
    const r = await merge(a, [u], null, backed);
    expect(r.rows[0].merged_ids).toEqual([u]);
    expect(r.rows[0].dropped_ids).toEqual([]);
    expect((await pointer()).r).toBe(`suppression_incomplete:${u}`);
  });

  it("backed ids are removed but other existing ids keep their order", async () => {
    const [x, y, z, u] = ids(4);
    await seed(`suppression_incomplete:${x},${y},${z}`);
    const r = await merge(a, [u], null, [y]);
    expect(r.rows[0].reason).toBe(`suppression_incomplete:${x},${z},${u}`);
  });

  it("cap alarm only when more than 10 UNBACKED ids exist", async () => {
    const un = ids(11);
    await seed(null);
    const r = await merge(a, un);
    expect(r.rows[0].merged_ids).toEqual(un.slice(0, 10));
    expect(r.rows[0].dropped_ids).toEqual([un[10]]);
  });

  it("hint is used only when the list would otherwise be empty", async () => {
    const [x, h] = ids(2);
    await seed(null);
    const r1 = await merge(a, [x], h);
    expect(r1.rows[0].reason).toBe(`suppression_incomplete:${x}`);
  });

  it("hint becomes the pointer when every existing id is backed", async () => {
    const [h] = ids(1);
    const old = ids(2);
    await seed(`suppression_incomplete:${old.join(",")}`);
    const r2 = await merge(a, [], h, old);
    expect(r2.rows[0].reason).toBe(`suppression_incomplete:${h}`);
  });

  it("the v1 signature no longer exists", async () => {
    await seed(null);
    await expect(
      a.query("select * from public.fn_merge_suppression_incomplete_pointer($1, $2::uuid[], null::text[], null::uuid)", [propertyId, []]),
    ).rejects.toThrow(/does not exist|is not unique/);
  });

  it("raises for an unknown property", async () => {
    await seed(null);
    await expect(
      a.query("select * from public.fn_merge_suppression_incomplete_pointer($1, $2::uuid[], $3::uuid[])", [randomUUID(), [], []]),
    ).rejects.toThrow(/property not found/);
  });

  it("authenticated and anon cannot execute; service_role can", async () => {
    await seed(null);
    const [x] = ids(1);
    for (const role of ["authenticated", "anon"]) {
      await a.query("begin");
      await a.query(`set local role ${role}`);
      await expect(merge(a, [x])).rejects.toThrow(/permission denied/);
      await a.query("rollback");
    }
    await a.query("begin");
    await a.query("set local role service_role");
    await merge(a, [x]);
    await a.query("rollback");
  });

  it("rollback drops the function", async () => {
    await seed(null);
    await a.query(ROLLBACK);
    await expect(merge(a, [])).rejects.toThrow(/does not exist/);
    // v1 is restored by the rollback.
    const v1 = await a.query("select * from public.fn_merge_suppression_incomplete_pointer($1, $2::uuid[])", [propertyId, []]);
    expect(v1.rowCount).toBe(1);
    await a.query(MIGRATION);
  });
});
