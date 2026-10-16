import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Messages v2 evidence layer (20261008143000). Local-only (loopback Postgres):
 * replays the idempotent migration, then checks constraints, RLS and the
 * realtime publication against real Postgres.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const MIGRATION = readFileSync(
  path.join(__dirname, "20261008143000_pipeline_runs.sql"),
  "utf8",
)
  .replace(/^begin;$/m, "")
  .replace(/^commit;$/m, "");

let orgId: string;
let otherOrgId: string;
let userId: string;
let messageId: string;

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
  otherOrgId = randomUUID();
  userId = randomUUID();
  messageId = randomUUID();
  for (const id of [orgId, otherOrgId]) {
    await db.query("insert into public.organizations (id, name) values ($1, $2)", [id, `Pipeline fixture ${id}`]);
  }
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [userId, `pr-${userId}@test.local`]);
  await db.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')`, [orgId, userId]);
  await db.query(
    `insert into public.messages (id, org_id, conversation_id, channel, direction, body)
     values ($1, $2, $3, 'sms', 'inbound', 'hi')`,
    [messageId, orgId, randomUUID()],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function insertRun(overrides: { messageId?: string } = {}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.pipeline_runs (id, org_id, inbound_message_id) values ($1, $2, $3)`,
    [id, orgId, overrides.messageId ?? messageId],
  );
  return id;
}

describe("pipeline_runs migration", () => {
  it("is idempotent when replayed", async () => {
    await expect(db.query(MIGRATION)).resolves.toBeDefined();
  });

  it("defaults status running and mode legacy", async () => {
    const id = await insertRun();
    const { rows } = await db.query("select status, mode, started_at from public.pipeline_runs where id=$1", [id]);
    expect(rows[0].status).toBe("running");
    expect(rows[0].mode).toBe("legacy");
    expect(rows[0].started_at).toBeTruthy();
  });

  it("allows only one run per inbound message", async () => {
    await insertRun();
    await db.query("savepoint s");
    await expect(insertRun()).rejects.toThrow(/duplicate key/);
    await db.query("rollback to savepoint s");
  });

  it("rejects invalid status, mode, kind and result values", async () => {
    const id = await insertRun();
    await db.query("savepoint s1");
    await expect(db.query("update public.pipeline_runs set status='bogus' where id=$1", [id])).rejects.toThrow(/status_check/);
    await db.query("rollback to savepoint s1");
    await db.query("savepoint s2");
    await expect(db.query("update public.pipeline_runs set mode='bogus' where id=$1", [id])).rejects.toThrow(/mode_check/);
    await db.query("rollback to savepoint s2");
    await db.query("savepoint s3");
    await expect(
      db.query(`insert into public.pipeline_run_steps (run_id, org_id, seq, kind, name, result) values ($1,$2,1,'bogus','x','pass')`, [id, orgId]),
    ).rejects.toThrow(/kind_check/);
    await db.query("rollback to savepoint s3");
    await db.query("savepoint s4");
    await expect(
      db.query(`insert into public.pipeline_run_steps (run_id, org_id, seq, kind, name, result) values ($1,$2,1,'gate','x','bogus')`, [id, orgId]),
    ).rejects.toThrow(/result_check/);
    await db.query("rollback to savepoint s4");
  });

  it("enforces unique (run_id, seq) and cascades step deletes", async () => {
    const id = await insertRun();
    const insertStep = (seq: number) =>
      db.query(`insert into public.pipeline_run_steps (run_id, org_id, seq, kind, name, result) values ($1,$2,$3,'gate','stop_keyword','block')`, [id, orgId, seq]);
    await insertStep(1);
    await db.query("savepoint s");
    await expect(insertStep(1)).rejects.toThrow(/duplicate key/);
    await db.query("rollback to savepoint s");
    await db.query("delete from public.pipeline_runs where id=$1", [id]);
    const { rows } = await db.query("select count(*)::int as n from public.pipeline_run_steps where run_id=$1", [id]);
    expect(rows[0].n).toBe(0);
  });

  it("lets same-org members read, hides other orgs, and blocks browser writes", async () => {
    const id = await insertRun();
    await db.query(`insert into public.pipeline_run_steps (run_id, org_id, seq, kind, name, result) values ($1,$2,1,'gate','x','pass')`, [id, orgId]);

    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    expect((await db.query("select id from public.pipeline_runs")).rows).toHaveLength(1);
    expect((await db.query("select id from public.pipeline_run_steps")).rows).toHaveLength(1);
    await db.query("savepoint s");
    await expect(db.query("update public.pipeline_runs set status='closed' where id=$1", [id])).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint s");
    await db.query("reset role");

    const outsider = randomUUID();
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [outsider, `out-${outsider}@test.local`]);
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [outsider]);
    expect((await db.query("select id from public.pipeline_runs")).rows).toHaveLength(0);
    expect((await db.query("select id from public.pipeline_run_steps")).rows).toHaveLength(0);
    await db.query("reset role");
  });

  it("lets service_role insert and update", async () => {
    await db.query("set local role service_role");
    const id = await insertRun();
    await db.query("update public.pipeline_runs set status='replied', completed_at=now() where id=$1", [id]);
    await db.query("reset role");
  });

  it("publishes both tables to supabase_realtime", async () => {
    const { rows } = await db.query(
      `select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('pipeline_runs','pipeline_run_steps')`,
    );
    expect(rows.map((r) => r.tablename).sort()).toEqual(["pipeline_run_steps", "pipeline_runs"]);
  });
});
