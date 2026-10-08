import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * wrong_number + hostile mapping keys (20261008320000). Local-only; each test
 * runs in a transaction that is rolled back. Requires a DB with the chain
 * through 20261008144200 applied; the Phase 4 migration (20261008310000) and
 * this one are re-applied here so the rollback can be exercised too.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const read = (rel: string) => strip(readFileSync(path.join(__dirname, rel), "utf8"));
const PHASE4 = read("20261008310000_auto_reply_templates.sql");
const MIGRATION = read("20261008320000_auto_reply_templates_wrong_number_hostile.sql");
const ROLLBACK = read("../rollbacks/20261008320000_auto_reply_templates_wrong_number_hostile.sql");

const db = new Client({ connectionString: url });
let orgId: string;
let templateId: string;
let ownerId: string;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  await db.query("savepoint as_user");
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [ownerId]);
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

const setMapping = (outcome: string, extra: unknown[] = [100, true, null, false]) => () =>
  db.query(`select public.fn_set_auto_reply_template($1, $2, $3, $4, $5, $6, $7, $8) as r`, [
    orgId,
    outcome,
    null,
    templateId,
    ...extra,
  ]);

const mappings = async () =>
  (await db.query(`select outcome from public.auto_reply_templates where org_id = $1 order by outcome`, [orgId])).rows.map(
    (r) => r.outcome as string,
  );

beforeEach(async () => {
  await db.query("begin");
  orgId = randomUUID();
  ownerId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, 'wn-hostile')", [orgId]);
  await db.query("set local session_replication_role = replica");
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [ownerId, `owner-${ownerId}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status, acquisitions_enabled)
     values ($1, $2, 'owner', 'active', false)`,
    [orgId, ownerId],
  );
  await db.query("set local session_replication_role = origin");
  await db.query(PHASE4);
  await db.query(MIGRATION);
  const t = await db.query(
    `insert into public.sms_templates (org_id, name, content) values ($1, 'ack', 'Thanks for letting us know.') returning id`,
    [orgId],
  );
  templateId = t.rows[0].id;
});
afterEach(async () => {
  await db.query("rollback");
});

describe("wrong_number and hostile mapping keys", () => {
  it("an owner can map wrong_number and hostile; nothing is seeded or approved", async () => {
    expect(await mappings()).toEqual([]);
    await asOwner(setMapping("wrong_number"));
    await asOwner(setMapping("hostile"));
    expect(await mappings()).toEqual(["hostile", "wrong_number"]);
    const tpl = (await db.query(`select approved_for_auto_send from public.sms_templates where id = $1`, [templateId])).rows[0];
    expect(tpl.approved_for_auto_send).toBe(false);
  });

  it("still rejects every outcome that must never auto-reply, in the RPC and in the table check", async () => {
    for (const outcome of ["new_lead", "opted_out", "dnc", "unclear", "bogus"]) {
      await expect(asOwner(setMapping(outcome))).rejects.toThrow(/INVALID_OUTCOME/);
    }
    await db.query("savepoint s");
    await expect(
      db.query(`insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, 'opted_out', $2)`, [orgId, templateId]),
    ).rejects.toThrow(/auto_reply_templates_outcome_check/);
    await db.query("rollback to savepoint s");
  });

  it("nurture and not_interested keep working", async () => {
    await asOwner(setMapping("nurture"));
    await asOwner(setMapping("not_interested"));
    expect(await mappings()).toEqual(["not_interested", "nurture"]);
  });

  it("is idempotent: applying it twice keeps the same constraint and function", async () => {
    await asOwner(setMapping("hostile"));
    await db.query(MIGRATION);
    await db.query(MIGRATION);
    expect(await mappings()).toEqual(["hostile"]);
  });
});

describe("rollback", () => {
  it("drops wrong_number/hostile mappings, keeps the others, and restores the Phase 4 allow-list", async () => {
    await asOwner(setMapping("wrong_number"));
    await asOwner(setMapping("hostile"));
    await asOwner(setMapping("nurture"));
    await db.query(ROLLBACK);
    expect(await mappings()).toEqual(["nurture"]);
    for (const outcome of ["wrong_number", "hostile"]) {
      await expect(asOwner(setMapping(outcome))).rejects.toThrow(/INVALID_OUTCOME/);
    }
    await db.query("savepoint s");
    await expect(
      db.query(`insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, 'hostile', $2)`, [orgId, templateId]),
    ).rejects.toThrow(/auto_reply_templates_outcome_check/);
    await db.query("rollback to savepoint s");
  });

  it("is idempotent and re-applies cleanly", async () => {
    await db.query(ROLLBACK);
    await db.query(ROLLBACK);
    await db.query(MIGRATION);
    await asOwner(setMapping("hostile"));
    expect(await mappings()).toEqual(["hostile"]);
  });
});
