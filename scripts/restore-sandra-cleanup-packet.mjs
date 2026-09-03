#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import pg from "pg";

import {
  EXPECTED_PROJECT_REF,
  assertDatabaseTarget,
  buildManifest,
  explicitQaContactId,
  sha256,
} from "./export-sandra-cleanup-packet.mjs";

const { Client, types } = pg;
types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1184, (value) => value);

export const EXPECTED_TEST_PROJECT_REF = "ncsngxlcyxylaeskiteu";
const DATABASE_URL_ENV = "SANDRA_TEST_DATABASE_URL";

export function parseRestoreArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--env" || token === "--packet" || token === "--manifest") {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${token}`);
      result[token.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (!result.packet || !result.manifest) {
    throw new Error(
      "Usage: restore-sandra-cleanup-packet.mjs [--env <file>] --packet <json> --manifest <json>",
    );
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(value)
  ) {
    const timestamp = new Date(value);
    if (Number.isFinite(timestamp.getTime())) return timestamp.toISOString();
  }
  return value;
}

export function rowsDigest(rows) {
  const identity = (row) =>
    row.id ?? `${String(row.org_id)}:${String(row.user_id)}`;
  return sha256(
    JSON.stringify(
      normalize(
        [...rows].sort((a, b) =>
          String(identity(a)).localeCompare(String(identity(b))),
        ),
      ),
    ),
  );
}

async function insertRows(client, table, rows, requiredColumns = ["id"]) {
  if (rows.length === 0) return;
  const columnsResult = await client.query(
    `select column_name from information_schema.columns
     where table_schema='public' and table_name=$1
       and is_generated='NEVER' and is_identity='NO'
     order by ordinal_position`,
    [table],
  );
  const sourceKeys = new Set(rows.flatMap((row) => Object.keys(row)));
  const columns = columnsResult.rows
    .map((row) => row.column_name)
    .filter((column) => sourceKeys.has(column));
  assert(
    requiredColumns.every((column) => columns.includes(column)),
    `Restore table ${table} is missing an insertable key.`,
  );
  const columnSql = columns.map(quoteIdentifier).join(", ");
  await client.query(
    `insert into public.${quoteIdentifier(table)} (${columnSql})
     select ${columnSql}
     from jsonb_populate_recordset(null::public.${quoteIdentifier(table)}, $1::jsonb)`,
    [JSON.stringify(rows)],
  );
}

async function selectRows(client, table, ids) {
  if (ids.length === 0) return [];
  const result = await client.query(
    `select to_jsonb(t) as row from public.${quoteIdentifier(table)} t
     where t.id = any($1::uuid[]) order by t.id`,
    [ids],
  );
  return result.rows.map((row) => row.row);
}

function commonProjection(actualRows, expectedRows) {
  const identity = (row) =>
    row.id ?? `${String(row.org_id)}:${String(row.user_id)}`;
  const expectedById = new Map(
    expectedRows.map((row) => [identity(row), row]),
  );
  return actualRows.map((actual) => {
    const expected = expectedById.get(identity(actual));
    assert(expected, `Unexpected restored row ${identity(actual)}.`);
    return Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]]));
  });
}

async function assertMembershipsAbsent(client, rows) {
  if (rows.length === 0) return;
  const keys = rows.map(
    (row) => `${String(row.org_id)}:${String(row.user_id)}`,
  );
  const result = await client.query(
    `select count(*)::int as count
     from public.memberships
     where org_id::text || ':' || user_id::text = any($1::text[])`,
    [keys],
  );
  assert(
    result.rows[0].count === 0,
    "Test database already contains packet membership rows.",
  );
}

async function selectMembershipRows(client, rows) {
  if (rows.length === 0) return [];
  const keys = rows.map(
    (row) => `${String(row.org_id)}:${String(row.user_id)}`,
  );
  const result = await client.query(
    `select to_jsonb(m) as row
     from public.memberships m
     where org_id::text || ':' || user_id::text = any($1::text[])
     order by org_id, user_id`,
    [keys],
  );
  return result.rows.map((row) => row.row);
}

async function assertIdsAbsent(client, table, ids) {
  if (ids.length === 0) return;
  const result = await client.query(
    `select count(*)::int as count from public.${quoteIdentifier(table)} where id=any($1::uuid[])`,
    [ids],
  );
  assert(result.rows[0].count === 0, `Test database already contains ${table} packet ids.`);
}

async function insertMissingAuthParents(client, groups) {
  const groupNames = groups.map(([table]) => table);
  const constraints = await client.query(
    `select child.relname as child_table, child_att.attname as child_column
     from pg_constraint constraint_row
     join pg_class child on child.oid=constraint_row.conrelid
     join pg_namespace child_ns on child_ns.oid=child.relnamespace
     join pg_class parent on parent.oid=constraint_row.confrelid
     join pg_namespace parent_ns on parent_ns.oid=parent.relnamespace
     join lateral unnest(constraint_row.conkey, constraint_row.confkey)
       with ordinality as columns(child_num, parent_num, ordinal) on true
     join pg_attribute child_att on child_att.attrelid=child.oid and child_att.attnum=columns.child_num
     join pg_attribute parent_att on parent_att.attrelid=parent.oid and parent_att.attnum=columns.parent_num
     where constraint_row.contype='f'
       and child_ns.nspname='public'
       and child.relname=any($1::text[])
       and parent_ns.nspname='auth' and parent.relname='users'
       and parent_att.attname='id'`,
    [groupNames],
  );
  const groupRows = new Map(groups);
  const ids = new Set();
  for (const constraint of constraints.rows) {
    for (const row of groupRows.get(constraint.child_table) ?? []) {
      const value = row[constraint.child_column];
      if (typeof value === "string" && value) ids.add(value);
    }
  }
  if (ids.size === 0) return;
  await client.query(
    `insert into auth.users (
       id, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
     )
     select id, 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now(), now()
     from unnest($1::uuid[]) id
     on conflict (id) do nothing`,
    [[...ids]],
  );
}

export async function verifyRestoreRoundTrip(client, packet) {
  assert(packet.format === "sandra-cleanup-packet-v2", "Unsupported cleanup packet format.");
  assert(packet.target?.projectRef === EXPECTED_PROJECT_REF, "Packet source is not Sandra production.");

  const explicitContactRows = packet.explicitQaProperties.contacts.filter(
    (row) => row.id === explicitQaContactId,
  );
  assert(explicitContactRows.length === 1, "Packet does not contain the exact deletable QA contact.");
  const groups = [
    // The second explicit contact is retained in production because real rows
    // share it. It is still restored into the isolated test transaction as a
    // supporting FK parent so the three QA properties can round-trip exactly.
    ["contacts", [
      ...packet.syntheticCohort.contacts,
      ...packet.explicitQaProperties.contacts,
    ]],
    ["sequences", packet.smokeSequences.sequences],
    ["properties", [
      ...packet.syntheticCohort.properties,
      ...packet.explicitQaProperties.properties,
    ]],
    ["sequence_steps", packet.smokeSequences.steps],
    ["lead_events", [
      ...packet.syntheticCohort.leadEvents,
      ...packet.explicitQaProperties.leadEvents,
    ]],
    ["tasks", packet.explicitQaProperties.tasks],
  ];
  const membershipRows =
    packet.qaMembershipAccessReview?.memberships ?? [];

  for (const [table, rows] of groups) {
    await assertIdsAbsent(client, table, rows.map((row) => row.id));
  }
  await assertMembershipsAbsent(client, membershipRows);
  const orgResult = await client.query(
    "select count(*)::int as count from public.organizations where id=$1::uuid",
    [packet.target.orgId],
  );
  assert(orgResult.rows[0].count === 1, "Test database lacks the packet organization.");

  await insertMissingAuthParents(client, [
    ...groups,
    ["memberships", membershipRows],
  ]);

  for (const [table] of groups) {
    await client.query(
      `alter table public.${quoteIdentifier(table)} disable trigger user`,
    );
  }
  for (const [table, rows] of groups) await insertRows(client, table, rows);
  if (membershipRows.length > 0) {
    await client.query("alter table public.memberships disable trigger user");
    await insertRows(client, "memberships", membershipRows, ["org_id", "user_id"]);
    await client.query("alter table public.memberships enable trigger user");
  }
  for (const [table] of [...groups].reverse()) {
    await client.query(
      `alter table public.${quoteIdentifier(table)} enable trigger user`,
    );
  }

  const verification = {};
  for (const [table, expected] of groups) {
    const actual = await selectRows(
      client,
      table,
      expected.map((row) => row.id),
    );
    assert(actual.length === expected.length, `Restored ${table} count mismatch.`);
    const projected = commonProjection(actual, expected);
    const expectedDigest = rowsDigest(expected);
    const actualDigest = rowsDigest(projected);
    assert(actualDigest === expectedDigest, `Restored ${table} digest mismatch.`);
    verification[table] = {
      count: actual.length,
      sha256: actualDigest,
    };
  }
  if (membershipRows.length > 0) {
    const actual = await selectMembershipRows(client, membershipRows);
    assert(
      actual.length === membershipRows.length,
      "Restored memberships count mismatch.",
    );
    const projected = commonProjection(actual, membershipRows);
    const expectedDigest = rowsDigest(membershipRows);
    const actualDigest = rowsDigest(projected);
    assert(
      actualDigest === expectedDigest,
      "Restored memberships digest mismatch.",
    );
    verification.memberships = {
      count: actual.length,
      sha256: actualDigest,
    };
  }
  return verification;
}

async function main() {
  const args = parseRestoreArgs(process.argv.slice(2));
  if (args.env) process.loadEnvFile(path.resolve(args.env));
  const [packetText, manifestText] = await Promise.all([
    readFile(path.resolve(args.packet), "utf8"),
    readFile(path.resolve(args.manifest), "utf8"),
  ]);
  const packet = JSON.parse(packetText);
  const manifest = JSON.parse(manifestText);
  const rebuilt = buildManifest(packet);
  assert(sha256(packetText) === manifest.exportSha256, "Export file hash does not match its manifest.");
  assert(
    rebuilt.manifest.stablePayloadSha256 === manifest.stablePayloadSha256,
    "Stable payload hash does not match its manifest.",
  );

  const connectionString = process.env[DATABASE_URL_ENV];
  assert(connectionString, `${DATABASE_URL_ENV} is missing.`);
  assertDatabaseTarget(connectionString, EXPECTED_TEST_PROJECT_REF);
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("begin isolation level serializable");
    const verification = await verifyRestoreRoundTrip(client, packet);
    await client.query("rollback");
    process.stdout.write(
      `${JSON.stringify({ mode: "TEST_ROLLBACK_RESTORE", sourceProjectRef: EXPECTED_PROJECT_REF, targetProjectRef: EXPECTED_TEST_PROJECT_REF, stablePayloadSha256: manifest.stablePayloadSha256, verification })}\n`,
    );
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
