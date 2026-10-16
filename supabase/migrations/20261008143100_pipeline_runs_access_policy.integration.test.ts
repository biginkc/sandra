import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Messages v2 access tightening (20261008143100). Local-only: replays the
 * evidence-layer migration and this one, then checks who can read
 * pipeline_runs / pipeline_run_steps through RLS.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const load = (name: string) =>
  readFileSync(path.join(__dirname, name), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, "");
const BASE = load("20261008143000_pipeline_runs.sql");
const MIGRATION = load("20261008143100_pipeline_runs_access_policy.sql");

let orgId: string;
let runId: string;
const users = {} as Record<"owner" | "acq" | "acqOwnerless" | "plain" | "expiredAcq" | "suspendedOwner", string>;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

async function addMember(
  key: keyof typeof users,
  role: "owner" | "member",
  extra: { acq?: boolean; status?: string; expires?: string | null } = {},
) {
  const id = randomUUID();
  users[key] = id;
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${key}-${id}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status, acquisitions_enabled, access_expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [orgId, id, role, extra.status ?? "active", extra.acq ?? false, extra.expires ?? null],
  );
}

beforeEach(async () => {
  await db.query("begin");
  await db.query(BASE);
  await db.query(MIGRATION);
  orgId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Access fixture ${orgId}`]);
  // Fixture-only: bypass the protected acquisitions_enabled designation trigger.
  await db.query("set local session_replication_role = replica");
  await addMember("owner", "owner");
  await addMember("acq", "member", { acq: true });
  await addMember("plain", "member");
  await addMember("expiredAcq", "member", { acq: true, expires: "2020-01-01T00:00:00Z" });
  await addMember("suspendedOwner", "owner", { status: "suspended" });
  await db.query("set local session_replication_role = origin");

  const messageId = randomUUID();
  await db.query(
    `insert into public.messages (id, org_id, conversation_id, channel, direction, body)
     values ($1, $2, $3, 'sms', 'inbound', 'hi')`,
    [messageId, orgId, randomUUID()],
  );
  runId = randomUUID();
  await db.query(`insert into public.pipeline_runs (id, org_id, inbound_message_id) values ($1, $2, $3)`, [runId, orgId, messageId]);
  await db.query(
    `insert into public.pipeline_run_steps (run_id, org_id, seq, kind, name, result) values ($1, $2, 1, 'gate', 'x', 'pass')`,
    [runId, orgId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function countAs(userId: string): Promise<{ runs: number; steps: number }> {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
  const runs = (await db.query("select id from public.pipeline_runs")).rows.length;
  const steps = (await db.query("select id from public.pipeline_run_steps")).rows.length;
  await db.query("reset role");
  return { runs, steps };
}

describe("pipeline_runs access policy", () => {
  it("is idempotent when replayed", async () => {
    await expect(db.query(MIGRATION)).resolves.toBeDefined();
  });

  it("lets an owner read runs and steps", async () => {
    expect(await countAs(users.owner)).toEqual({ runs: 1, steps: 1 });
  });

  it("lets an Acquisitions member read runs and steps", async () => {
    expect(await countAs(users.acq)).toEqual({ runs: 1, steps: 1 });
  });

  it("hides runs and steps from a plain member", async () => {
    expect(await countAs(users.plain)).toEqual({ runs: 0, steps: 0 });
  });

  it("hides rows when the Acquisitions grant has expired or the owner is suspended", async () => {
    expect(await countAs(users.expiredAcq)).toEqual({ runs: 0, steps: 0 });
    expect(await countAs(users.suspendedOwner)).toEqual({ runs: 0, steps: 0 });
  });

  it("still lets service_role read and write", async () => {
    await db.query("set local role service_role");
    expect((await db.query("select id from public.pipeline_runs")).rows).toHaveLength(1);
    await db.query("update public.pipeline_runs set status='replied' where id=$1", [runId]);
    await db.query("reset role");
  });
});
