import { readFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadTestEnv } from "@tests/integration/env";

const migrationSql = readFileSync(
  "supabase/migrations/20260830100000_esign_switchboard_webhook_constraint_union.sql",
  "utf8",
);
const migrationBody = migrationSql
  .replace(/^[\s\S]*?\nbegin;\s*/iu, "")
  .replace(/\s*commit;\s*$/iu, "");

const allowedTypes = [
  "lead",
  "provider",
  "jitter_writeback",
  "closer_practice",
  "bmh_institute_course",
  "esign_provider",
  "switchboard_contact_preference",
] as const;

let pg: Client;
let orgId = "";

function testDbUrl(): string {
  const env = loadTestEnv();
  const value = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!value) throw new Error("Missing TEST_SUPABASE_DB_URL.");
  const url = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Constraint-union integration tests require isolated local PostgreSQL.");
  }
  return url.toString();
}

async function expectDbError(operation: () => Promise<unknown>): Promise<void> {
  await pg.query("savepoint expected_error");
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  await pg.query("rollback to savepoint expected_error");
  await pg.query("release savepoint expected_error");
  expect(caught).toMatchObject({ message: expect.stringMatching(/check constraint/i) });
}

async function replaceWithHistoricalConstraint(types: readonly string[]): Promise<void> {
  const quoted = types.map((type) => `'${type}'`).join(",");
  const nonLead = types.filter((type) => type !== "lead").map((type) => `'${type}'`).join(",");
  await pg.query(`
    alter table public.webhook_consumers
      drop constraint if exists webhook_consumers_type_check;
    alter table public.webhook_consumers
      add constraint webhook_consumers_type_check
      check (consumer_type = any (array[${quoted}]));
    alter table public.webhook_consumers
      drop constraint if exists webhook_consumers_type_source_match_check;
    alter table public.webhook_consumers
      add constraint webhook_consumers_type_source_match_check
      check (
        (consumer_type='lead' and default_source is not null)
        or (consumer_type in (${nonLead}) and default_source is null)
      );
  `);
}

async function insertConsumer(type: string, defaultSource: string | null): Promise<void> {
  await pg.query(
    `insert into public.webhook_consumers(
       name,secret_hash,consumer_type,default_source,org_id,enabled
     ) values ($1,$2,$3,$4,$5,true)`,
    [
      `Union ${type} ${crypto.randomUUID()}`,
      crypto.randomUUID().replaceAll("-", ""),
      type,
      defaultSource,
      orgId,
    ],
  );
}

async function assertFinalUnion(): Promise<void> {
  const constraints = await pg.query<{
    conname: string;
    convalidated: boolean;
    definition: string;
  }>(
    `select conname,convalidated,pg_get_constraintdef(oid,true) definition
       from pg_constraint
      where conrelid='public.webhook_consumers'::regclass
        and conname=any(array[
          'webhook_consumers_type_check',
          'webhook_consumers_type_source_match_check'
        ]) order by conname`,
  );
  expect(constraints.rows).toHaveLength(2);
  expect(constraints.rows.every((row) => row.convalidated)).toBe(true);
  const definitions = constraints.rows.map((row) => row.definition).join("\n");
  for (const type of allowedTypes) expect(definitions).toContain(type);

  for (const type of allowedTypes) {
    await insertConsumer(type, type === "lead" ? "cold_call" : null);
  }
  await expectDbError(() => insertConsumer("lead", null));
  for (const type of allowedTypes.filter((candidate) => candidate !== "lead")) {
    await expectDbError(() => insertConsumer(type, "cold_call"));
  }
  await expectDbError(() => insertConsumer("unreviewed_type", null));
}

beforeAll(async () => {
  pg = new Client({ connectionString: testDbUrl() });
  await pg.connect();
  await pg.query("begin");
});

beforeEach(async () => {
  orgId = crypto.randomUUID();
  await pg.query("savepoint union_case");
  await pg.query("insert into public.organizations(id,name) values ($1,$2)", [
    orgId,
    `Union ${orgId}`,
  ]);
});

afterEach(async () => {
  await pg.query("rollback to savepoint union_case");
  await pg.query("release savepoint union_case");
});

afterAll(async () => {
  if (pg) {
    await pg.query("rollback");
    await pg.end();
  }
});

describe("Migration 20260830100000 — eSign/Switchboard webhook constraint union", () => {
  it("contains only the two compatibility checks and their transaction guards", () => {
    expect(migrationSql).toContain("lock table public.webhook_consumers in access exclusive mode");
    expect(migrationSql).toContain("webhook_consumers_type_check");
    expect(migrationSql).toContain("webhook_consumers_type_source_match_check");
    expect(migrationSql).not.toMatch(/create table|drop table|create function|drop function/iu);
  });

  it("restores the exact union after the eSign-last production shape", async () => {
    await replaceWithHistoricalConstraint([
      "lead",
      "provider",
      "jitter_writeback",
      "closer_practice",
      "bmh_institute_course",
      "esign_provider",
    ]);
    await pg.query(migrationBody);
    await assertFinalUnion();
  });

  it("restores the exact union after the Switchboard-last TEST/fresh shape", async () => {
    await replaceWithHistoricalConstraint([
      "lead",
      "provider",
      "jitter_writeback",
      "closer_practice",
      "bmh_institute_course",
      "switchboard_contact_preference",
    ]);
    await pg.query(migrationBody);
    await assertFinalUnion();
  });

  it("is directly replay-safe and retains the same validated union", async () => {
    await pg.query(migrationBody);
    await pg.query(migrationBody);
    await assertFinalUnion();
  });
});
