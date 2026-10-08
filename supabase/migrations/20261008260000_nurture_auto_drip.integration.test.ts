import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * Nurture auto-drip switch (20261008260000). Local-only; each test runs in a
 * transaction that is rolled back. The migration (and its rollback) is applied
 * inside the test, so it only needs the base tables (ai_responder_configs,
 * sequences, memberships).
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261008260000_nurture_auto_drip.sql"), "utf8"));
const ROLLBACK = strip(readFileSync(path.join(__dirname, "../rollbacks/20261008260000_nurture_auto_drip.sql"), "utf8"));

const db = new Client({ connectionString: url });
let orgId: string;
let otherOrgId: string;
let configId: string;
let sequenceId: string;
let otherOrgSequenceId: string;
const users = {} as Record<"owner" | "member", string>;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

async function addMember(key: keyof typeof users, role: "owner" | "member") {
  const id = randomUUID();
  users[key] = id;
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${key}-${id}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, $3, 'active')`,
    [orgId, id, role],
  );
}

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

const setSwitch = (enabled: boolean, seq: string | null, ...rest: Array<string | null>) => () => {
  // One drip for every route unless the test gives all four.
  const four = rest.length === 3 ? [seq, ...rest] : [seq, seq, seq, seq];
  return db.query(`select public.fn_set_nurture_auto_drip($1, $2, $3, $4, $5, $6) as r`, [configId, enabled, ...four]);
};

const cfg = async () =>
  (await db.query(`select nurture_auto_drip, nurture_drip_maybe_later_sequence_id as ml, nurture_drip_check_in_60_sequence_id as c60, nurture_drip_listed_not_selling_sequence_id as ls, nurture_drip_hot_book_appointment_sequence_id as hot from public.ai_responder_configs where id = $1`, [configId]))
    .rows[0];

beforeEach(async () => {
  await db.query("begin");
  orgId = randomUUID();
  otherOrgId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $3), ($2, $4)", [orgId, otherOrgId, `nd-${orgId}`, `nd-other-${otherOrgId}`]);
  await db.query("set local session_replication_role = replica");
  await addMember("owner", "owner");
  await addMember("member", "member");
  await db.query("set local session_replication_role = origin");
  const c = await db.query(
    `insert into public.ai_responder_configs (org_id, system_prompt) values ($1, 'x') returning id`,
    [orgId],
  );
  configId = c.rows[0].id;
  sequenceId = (await db.query(`insert into public.sequences (org_id, name, active) values ($1, 'Nurture', true) returning id`, [orgId])).rows[0].id;
  otherOrgSequenceId = (await db.query(`insert into public.sequences (org_id, name, active) values ($1, 'Other', true) returning id`, [otherOrgId])).rows[0].id;
  await db.query(MIGRATION);
});
afterEach(async () => {
  await db.query("rollback");
});

describe("nurture auto-drip switch", () => {
  it("is OFF with no drip by default (zero behaviour change)", async () => {
    expect(await cfg()).toEqual({ nurture_auto_drip: false, ml: null, c60: null, ls: null, hot: null });
  });

  it("an owner turns it on with a drip, and off again", async () => {
    await asUser(users.owner, setSwitch(true, sequenceId));
    expect(await cfg()).toEqual({ nurture_auto_drip: true, ml: sequenceId, c60: sequenceId, ls: sequenceId, hot: sequenceId });
    await asUser(users.owner, setSwitch(false, sequenceId));
    expect((await cfg()).nurture_auto_drip).toBe(false);
  });

  it("refuses to turn on without a drip, with another org's drip, or with an inactive drip", async () => {
    await expect(asUser(users.owner, setSwitch(true, null))).rejects.toThrow(/DRIP_REQUIRED/);
    await expect(asUser(users.owner, setSwitch(true, otherOrgSequenceId))).rejects.toThrow(/DRIP_UNAVAILABLE/);
    await db.query(`update public.sequences set active = false where id = $1`, [sequenceId]);
    await expect(asUser(users.owner, setSwitch(true, sequenceId))).rejects.toThrow(/DRIP_UNAVAILABLE/);
    expect((await cfg()).nurture_auto_drip).toBe(false);
  });

  it("cannot be turned on unless ALL FOUR routes have a drip, and each must be this org's active drip", async () => {
    const other = (await db.query(`insert into public.sequences (org_id, name, active) values ($1, 'Second', true) returning id`, [orgId])).rows[0].id;
    for (let missing = 0; missing < 4; missing++) {
      const four = [sequenceId, other, sequenceId, other];
      four[missing] = null as unknown as string;
      await expect(asUser(users.owner, setSwitch(true, four[0], four[1], four[2], four[3]))).rejects.toThrow(/DRIP_REQUIRED/);
    }
    await expect(asUser(users.owner, setSwitch(true, sequenceId, other, sequenceId, otherOrgSequenceId))).rejects.toThrow(/DRIP_UNAVAILABLE/);
    await asUser(users.owner, setSwitch(true, sequenceId, other, sequenceId, other));
    expect(await cfg()).toEqual({ nurture_auto_drip: true, ml: sequenceId, c60: other, ls: sequenceId, hot: other });
  });

  it("only an owner may change it", async () => {
    await expect(asUser(users.member, setSwitch(true, sequenceId))).rejects.toThrow(/FORBIDDEN/);
    expect((await cfg()).nurture_auto_drip).toBe(false);
  });

  it("the table itself refuses 'on' with no drip (check constraint)", async () => {
    await expect(
      db.query(`update public.ai_responder_configs set nurture_auto_drip = true where id = $1`, [configId]),
    ).rejects.toThrow(/nurture_auto_drip_sequences_check/);
  });

  it("deleting the chosen drip while the switch is on is refused, so 'on' can never point at nothing", async () => {
    await asUser(users.owner, setSwitch(true, sequenceId));
    await expect(db.query(`delete from public.sequences where id = $1`, [sequenceId])).rejects.toThrow();
  });

  it("the rollback removes the columns, constraint and RPC", async () => {
    await db.query(ROLLBACK);
    const cols = await db.query(
      `select column_name from information_schema.columns where table_name = 'ai_responder_configs' and (column_name like 'nurture_auto_drip%' or column_name like 'nurture_drip_%')`,
    );
    expect(cols.rows).toEqual([]);
    const fn = await db.query(`select 1 from pg_proc where proname = 'fn_set_nurture_auto_drip'`);
    expect(fn.rows).toEqual([]);
  });
});
