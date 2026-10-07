import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Messages v2 Phase 5 replay tables (20261008155000). Local-only (loopback
 * Postgres): replays the idempotent migration inside a rolled-back transaction.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const MIGRATION = readFileSync(path.join(__dirname, "20261008155000_replay_harness.sql"), "utf8")
  .replace(/^begin;$/m, "")
  .replace(/^commit;$/m, "");

let orgId: string;
let ownerId: string;
let memberId: string;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query("begin");
  await db.query(MIGRATION);
  orgId = randomUUID();
  ownerId = randomUUID();
  memberId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, 'Replay fixture')", [orgId]);
  for (const [id, role] of [[ownerId, "owner"], [memberId, "member"]] as const) {
    await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [id, `r-${id}@test.local`]);
    await db.query(
      "insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, $3, 'active')",
      [orgId, id, role],
    );
  }
  await db.query("insert into public.replay_batches (id, org_id, source_label) values ('2026-10-07', $1, 'fixture')", [orgId]);
  await db.query(
    "insert into public.replay_outbound_log (batch_id, provider, to_address, body, external_id) values ('2026-10-07','sendillo','+18165550123','hi','replay-stub-1')",
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function asUser(userId: string, sql: string) {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
  try {
    return (await db.query(sql)).rows;
  } finally {
    await db.query("reset role");
  }
}

describe("replay harness migration", () => {
  it("is idempotent when replayed", async () => {
    await expect(db.query(MIGRATION)).resolves.toBeDefined();
  });

  it("allows one batch per org and validates the batch id", async () => {
    await db.query("savepoint s");
    await expect(
      db.query("insert into public.replay_batches (id, org_id) values ('second', $1)", [orgId]),
    ).rejects.toThrow(/duplicate key/);
    await db.query("rollback to savepoint s");
    await db.query("savepoint s2");
    await expect(
      db.query("insert into public.replay_batches (id, org_id) values ('Bad Id!', $1)", [randomUUID()]),
    ).rejects.toThrow();
    await db.query("rollback to savepoint s2");
  });

  it("lets only the replay org's owner read the batch and the outbound log", async () => {
    expect(await asUser(ownerId, "select id from public.replay_batches")).toHaveLength(1);
    expect(await asUser(ownerId, "select id from public.replay_outbound_log")).toHaveLength(1);
    expect(await asUser(memberId, "select id from public.replay_batches")).toHaveLength(0);
    expect(await asUser(memberId, "select id from public.replay_outbound_log")).toHaveLength(0);
    const stranger = randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, $2)", [stranger, `s-${stranger}@test.local`]);
    expect(await asUser(stranger, "select id from public.replay_batches")).toHaveLength(0);
  });

  it("denies browser writes and any browser access to the tag table", async () => {
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [ownerId]);
    await db.query("savepoint s");
    await expect(db.query("delete from public.replay_batches")).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint s");
    await db.query("savepoint s2");
    await expect(db.query("select * from public.replay_row_tags")).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint s2");
    await db.query("reset role");
  });

  it("lets service_role write, and deleting a batch cascades its tags and log", async () => {
    await db.query("set local role service_role");
    await db.query("insert into public.replay_row_tags (batch_id, table_name, row_id) values ('2026-10-07','contacts','c1')");
    await db.query("reset role");
    await db.query("delete from public.replay_batches where id='2026-10-07'");
    expect((await db.query("select 1 from public.replay_row_tags")).rows).toHaveLength(0);
    expect((await db.query("select 1 from public.replay_outbound_log")).rows).toHaveLength(0);
  });
});
