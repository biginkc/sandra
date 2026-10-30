import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * routing v2 mapping keys (20261030131000). Local-only; each test runs in a
 * transaction that is rolled back. Requires a DB with the chain through
 * 20261008144200 applied; the Phase 4 migration (20261008310000) and this one
 * are re-applied here so the rollback can be exercised too.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const read = (rel: string) => strip(readFileSync(path.join(__dirname, rel), "utf8"));
const PHASE4 = read("20261008310000_auto_reply_templates.sql");
const NUMBER_SOURCE = read("20261012020000_auto_reply_templates_number_source.sql");
const MIGRATION = read("20261030131000_auto_reply_templates_routing_v2_keys.sql");
const ROLLBACK = read("../rollbacks/20261030131000_auto_reply_templates_routing_v2_keys.sql");
const V2_KEYS = ["where_property", "where_located", "text_only", "how_it_works", "driving", "price_too_high", "no_repairs_realtor", "fair_price"];

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

const setMapping = (outcome: string) => () =>
  db.query(`select public.fn_set_auto_reply_template($1, $2, $3, $4, $5, $6, $7, $8) as r`, [
    orgId,
    outcome,
    null,
    templateId,
    100,
    true,
    null,
    false,
  ]);

const mappings = async () =>
  (await db.query(`select outcome from public.auto_reply_templates where org_id = $1 order by outcome`, [orgId])).rows.map(
    (r) => r.outcome as string,
  );

/** What PR #851's 20261009040000 does to the same constraint + RPC allow-list. */
async function widenLikeWrongNumberHostile() {
  await db.query(`alter table public.auto_reply_templates drop constraint auto_reply_templates_outcome_check`);
  await db.query(
    `alter table public.auto_reply_templates add constraint auto_reply_templates_outcome_check
       check (outcome in ('nurture', 'not_interested', 'wrong_number', 'hostile'))`,
  );
  await db.query(`
    do $$
    declare v_fn text; v_new text;
    begin
      v_fn := pg_get_functiondef('public.fn_set_auto_reply_template(uuid, text, text, uuid, integer, boolean, uuid, boolean)'::regprocedure);
      v_new := replace(v_fn, 'p_outcome not in (''nurture'', ''not_interested'')', 'p_outcome not in (''nurture'', ''not_interested'', ''wrong_number'', ''hostile'')');
      if v_new = v_fn then raise exception 'test widening anchor not found'; end if;
      execute v_new;
    end $$`);
}

beforeEach(async () => {
  await db.query("begin");
  orgId = randomUUID();
  ownerId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, 'routing-v2-keys')", [orgId]);
  await db.query("set local session_replication_role = replica");
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [ownerId, `owner-${ownerId}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status, acquisitions_enabled)
     values ($1, $2, 'owner', 'active', false)`,
    [orgId, ownerId],
  );
  await db.query("set local session_replication_role = origin");
  await db.query(PHASE4);
  const t = await db.query(
    `insert into public.sms_templates (org_id, name, content) values ($1, 'ack', 'Thanks for letting us know.') returning id`,
    [orgId],
  );
  templateId = t.rows[0].id;
});
afterEach(async () => {
  await db.query("rollback");
});

describe("routing v2 mapping keys", () => {
  it("an owner can map every v2 key after the migration; nothing is seeded or approved", async () => {
    await db.query(MIGRATION);
    expect(await mappings()).toEqual([]);
    for (const k of V2_KEYS) await asOwner(setMapping(k));
    expect(await mappings()).toEqual([...V2_KEYS].sort());
    const tpl = (await db.query(`select approved_for_auto_send from public.sms_templates where id = $1`, [templateId])).rows[0];
    expect(tpl.approved_for_auto_send).toBe(false);
  });

  it("is refused before the migration", async () => {
    await expect(asOwner(setMapping("fair_price"))).rejects.toThrow(/INVALID_OUTCOME/);
  });

  it("keeps prior keys (wrong_number/hostile/number_source) and still rejects never-auto outcomes", async () => {
    await widenLikeWrongNumberHostile();
    await db.query(NUMBER_SOURCE);
    await db.query(MIGRATION);
    await db.query(MIGRATION);
    for (const k of ["nurture", "not_interested", "wrong_number", "hostile", "number_source", "fair_price"]) await asOwner(setMapping(k));
    for (const outcome of ["new_lead", "opted_out", "dnc", "unclear", "bogus"]) {
      await expect(asOwner(setMapping(outcome))).rejects.toThrow(/INVALID_OUTCOME/);
    }
    await db.query("savepoint s");
    await expect(
      db.query(`insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, 'dnc', $2)`, [orgId, templateId]),
    ).rejects.toThrow(/auto_reply_templates_outcome_check/);
    await db.query("rollback to savepoint s");
  });
});

describe("rollback", () => {
  it("drops v2 mappings, keeps the others, and is idempotent", async () => {
    await db.query(NUMBER_SOURCE);
    await db.query(MIGRATION);
    await asOwner(setMapping("fair_price"));
    await asOwner(setMapping("number_source"));
    await db.query(ROLLBACK);
    await db.query(ROLLBACK);
    expect(await mappings()).toEqual(["number_source"]);
    await expect(asOwner(setMapping("fair_price"))).rejects.toThrow(/INVALID_OUTCOME/);
    await asOwner(setMapping("nurture"));
    await db.query(MIGRATION);
    await asOwner(setMapping("driving"));
    expect(await mappings()).toEqual(["driving", "number_source", "nurture"]);
  });
});
