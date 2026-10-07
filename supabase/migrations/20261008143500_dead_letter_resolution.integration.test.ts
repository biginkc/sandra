import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Dead-letter resolution (20261008143500). Local-only. Replays the
 * 20261008140000..20261008143500 chain inside a rolled-back transaction.
 */
const dir = __dirname;
const CHAIN = readdirSync(dir)
  .filter((f) => /^20261008\d{6}_.*\.sql$/.test(f) && f >= "20261008140000" && f <= "20261008143500_zz")
  .sort()
  .map((f) => readFileSync(path.join(dir, f), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, ""));
const MIGRATION = readFileSync(path.join(dir, "20261008143500_dead_letter_resolution.sql"), "utf8");
const url = process.env.TEST_SUPABASE_DB_URL;
const db = new Client({ connectionString: url });
let orgId: string;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

async function insertLetter(reason: string, inbound: string, extra = "") {
  const id = randomUUID();
  await db.query(
    `insert into public.ai_reply_dead_letters (id, org_id, inbound_message_id, body, reason ${extra ? ", resolved_at" : ""})
     values ($1, $2, $3, 'text', $4 ${extra ? ", now()" : ""})`,
    [id, orgId, inbound, reason],
  );
  return id;
}

describe("ai_reply_dead_letters.resolved_at", () => {
  beforeEach(async () => {
    await db.query("begin");
    for (const sql of CHAIN) await db.query(sql);
    orgId = randomUUID();
    await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Resolve ${orgId}`]);
    await db.query("set local session_replication_role = replica");
  });
  afterEach(async () => {
    await db.query("rollback");
  });

  it("adds a nullable resolved_at and the partial unresolved-timeout index", async () => {
    const col = await db.query(
      `select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'ai_reply_dead_letters' and column_name = 'resolved_at'`,
    );
    expect(col.rows[0]?.is_nullable).toBe("YES");
    const idx = await db.query(
      `select indexdef from pg_indexes where indexname = 'idx_ai_reply_dead_letters_unresolved_timeout'`,
    );
    expect(idx.rows[0].indexdef).toMatch(/\(created_at, id\)/);
    expect(idx.rows[0].indexdef).toMatch(/resolved_at IS NULL/);
    expect(idx.rows[0].indexdef).toMatch(/send_timeout/);
  });

  it("service_role may update resolved_at only; other columns and authenticated are denied", async () => {
    const id = await insertLetter("send_timeout", randomUUID());
    await db.query("savepoint a");
    await db.query("set local role service_role");
    await db.query("update public.ai_reply_dead_letters set resolved_at = now() where id = $1", [id]);
    await db.query("savepoint b");
    await expect(
      db.query("update public.ai_reply_dead_letters set body = 'tampered' where id = $1", [id]),
    ).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint b");
    await db.query("reset role");
    await db.query("set local role authenticated");
    await expect(
      db.query("update public.ai_reply_dead_letters set resolved_at = now() where id = $1", [id]),
    ).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint a");
    await db.query("reset role");
    const { rows } = await db.query("select resolved_at, body from public.ai_reply_dead_letters where id = $1", [id]);
    expect(rows[0]).toMatchObject({ resolved_at: null, body: "text" });
  });

  it("the migration backfills timeouts that already have a sent_late marker (and is re-runnable)", async () => {
    const withMarker = randomUUID();
    const without = randomUUID();
    const a = await insertLetter("send_timeout", withMarker);
    await insertLetter("sent_late", withMarker);
    const b = await insertLetter("send_timeout", without);
    await db.query("update public.ai_reply_dead_letters set resolved_at = null");
    await db.query(MIGRATION.replace(/^begin;$/m, "").replace(/^commit;$/m, ""));
    const { rows } = await db.query(
      "select id, resolved_at is not null as resolved from public.ai_reply_dead_letters where id = any($1)",
      [[a, b]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.resolved]))).toEqual({ [a]: true, [b]: false });
  });

  it("the unresolved-timeout index is usable: an unresolved row behind many resolved rows is the first read", async () => {
    for (let i = 0; i < 50; i += 1) await insertLetter("send_timeout", randomUUID(), "resolved");
    const target = await insertLetter("send_timeout", randomUUID());
    const { rows } = await db.query(
      `select id from public.ai_reply_dead_letters
       where reason = 'send_timeout' and resolved_at is null
       order by created_at, id limit 1`,
    );
    expect(rows[0].id).toBe(target);
  });
});
