import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * PR 4 rules-panel switches (20261016030000). Local-only; each test runs in a transaction that is
 * rolled back. The migration (and its rollback) is applied inside the test.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "").replace(/^\s*set local (lock|statement)_timeout.*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261016030000_nine_rule_switches.sql"), "utf8"));
const ROLLBACK = strip(readFileSync(path.join(__dirname, "../rollbacks/20261016030000_nine_rule_switches.sql"), "utf8"));

const db = new Client({ connectionString: url });
let orgId: string;
let configId: string;
const users = {} as Record<"owner" | "member" | "outsider", string>;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

async function addUser(key: keyof typeof users, org: string | null, role: "owner" | "member") {
  const id = randomUUID();
  users[key] = id;
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${key}-${id}@test.local`]);
  if (org) {
    await db.query(`insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, $3, 'active')`, [org, id, role]);
  }
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

const set = (name: string, value: string) => () =>
  db.query(`select public.fn_set_ai_rule_switch($1, $2, $3) as r`, [configId, name, value]);
const cfg = async () =>
  (await db.query(`select nine_identity_reply, nine_confirmed_owner_drip, classifier_engine from public.ai_responder_configs where id = $1`, [configId])).rows[0];
const log = async () =>
  (await db.query(`select switch_name, old_value, new_value, changed_by from public.ai_rule_switch_events where config_id = $1 order by id`, [configId])).rows;

beforeEach(async () => {
  await db.query("begin");
  orgId = randomUUID();
  const otherOrg = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $3), ($2, $4)", [orgId, otherOrg, `rs-${orgId}`, `rs-other-${otherOrg}`]);
  await db.query("set local session_replication_role = replica");
  await addUser("owner", orgId, "owner");
  await addUser("member", orgId, "member");
  await addUser("outsider", otherOrg, "owner");
  await db.query("set local session_replication_role = origin");
  await db.query(MIGRATION);
  configId = (await db.query(`insert into public.ai_responder_configs (org_id, system_prompt) values ($1, 'x') returning id`, [orgId])).rows[0].id;
});
afterEach(async () => {
  await db.query("rollback");
});

describe("nine rule switches", () => {
  it("default ON (no behaviour change until an owner turns one off)", async () => {
    expect(await cfg()).toEqual({ nine_identity_reply: true, nine_confirmed_owner_drip: true, classifier_engine: "outcome_v1" });
  });

  it("an owner flips each switch; every change is logged with who", async () => {
    await asUser(users.owner, set("nine_identity_reply", "false"));
    await asUser(users.owner, set("nine_confirmed_owner_drip", "false"));
    await asUser(users.owner, set("classifier_engine", "nine_questions"));
    expect(await cfg()).toEqual({ nine_identity_reply: false, nine_confirmed_owner_drip: false, classifier_engine: "nine_questions" });
    expect(await log()).toEqual([
      { switch_name: "nine_identity_reply", old_value: "true", new_value: "false", changed_by: users.owner },
      { switch_name: "nine_confirmed_owner_drip", old_value: "true", new_value: "false", changed_by: users.owner },
      { switch_name: "classifier_engine", old_value: "outcome_v1", new_value: "nine_questions", changed_by: users.owner },
    ]);
    const at = (await db.query(`select changed_at from public.ai_rule_switch_events where config_id = $1`, [configId])).rows;
    for (const r of at) expect(r.changed_at).toBeInstanceOf(Date);
  });

  it("changes made outside the new setter (existing RPCs) are logged by the trigger too", async () => {
    await db.query(`update public.ai_responder_configs set reply_generation = 'off' where id = $1`, [configId]);
    expect((await log()).map((r) => r.switch_name)).toEqual(["reply_generation"]);
  });

  it("fails closed: members, other orgs' owners and bad values are refused; nothing changes or is logged", async () => {
    await expect(asUser(users.member, set("nine_identity_reply", "false"))).rejects.toThrow(/FORBIDDEN/);
    await expect(asUser(users.outsider, set("nine_identity_reply", "false"))).rejects.toThrow(/FORBIDDEN/);
    await expect(asUser(users.owner, set("nine_identity_reply", "maybe"))).rejects.toThrow(/INVALID_REQUEST/);
    await expect(asUser(users.owner, set("nurture_auto_drip", "true"))).rejects.toThrow(/INVALID_REQUEST/);
    await expect(asUser(users.owner, set("classifier_engine", "nine"))).rejects.toThrow(/INVALID_REQUEST/);
    expect(await cfg()).toEqual({ nine_identity_reply: true, nine_confirmed_owner_drip: true, classifier_engine: "outcome_v1" });
    expect(await log()).toEqual([]);
  });

  it("a signed-in member cannot write the log or the columns directly; owners read only their org's log", async () => {
    await asUser(users.owner, set("nine_identity_reply", "false"));
    await expect(
      asUser(users.member, () => db.query(`insert into public.ai_rule_switch_events (org_id, config_id, switch_name) values ($1, $2, 'x')`, [orgId, configId])),
    ).rejects.toThrow(/permission denied/);
    expect((await asUser(users.owner, () => db.query(`select 1 from public.ai_rule_switch_events where org_id = $1`, [orgId]))).rowCount).toBe(1);
    expect((await asUser(users.member, () => db.query(`select 1 from public.ai_rule_switch_events where org_id = $1`, [orgId]))).rowCount).toBe(0);
    expect((await asUser(users.outsider, () => db.query(`select 1 from public.ai_rule_switch_events where org_id = $1`, [orgId]))).rowCount).toBe(0);
  });

  it("an expired or deletion-prepared owner cannot read the log (same conditions as the setter)", async () => {
    await asUser(users.owner, set("nine_identity_reply", "false"));
    const read = () => asUser(users.owner, () => db.query(`select 1 from public.ai_rule_switch_events where org_id = $1`, [orgId]));
    expect((await read()).rowCount).toBe(1);
    // The final-owner guard would refuse these test-only edits; bypass triggers as the setup does.
    await db.query("set local session_replication_role = replica");
    await db.query(`update public.memberships set access_expires_at = now() - interval '1 minute' where user_id = $1`, [users.owner]);
    expect((await read()).rowCount).toBe(0);
    await db.query(`update public.memberships set access_expires_at = null, deletion_prepared_at = now() where user_id = $1`, [users.owner]);
    await db.query("set local session_replication_role = origin");
    expect((await read()).rowCount).toBe(0);
  });

  it("rollback removes everything and is idempotent", async () => {
    await db.query(ROLLBACK);
    await db.query(ROLLBACK);
    const cols = await db.query(
      `select column_name from information_schema.columns where table_schema='public' and table_name='ai_responder_configs' and column_name in ('nine_identity_reply','nine_confirmed_owner_drip')`,
    );
    expect(cols.rowCount).toBe(0);
    expect((await db.query(`select to_regclass('public.ai_rule_switch_events') as t`)).rows[0].t).toBeNull();
    await db.query(MIGRATION);
    expect(await cfg()).toEqual({ nine_identity_reply: true, nine_confirmed_owner_drip: true, classifier_engine: "outcome_v1" });
  });
});
