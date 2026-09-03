#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import pg from "pg";

const { Client, types } = pg;
types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1184, (value) => value);

export const EXPECTED_PROJECT_REF = "copflsklaefwzipsrjqz";
const EXPECTED_ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const DATABASE_URL_ENV = "SANDRA_PRODUCTION_DATABASE_URL";
const SYNTHETIC_CREATED_FROM = "2026-05-15T04:02:54.000Z";
const SYNTHETIC_CREATED_TO = "2026-05-15T04:02:56.000Z";
const SYNTHETIC_DELETED_AT = "2026-06-17T18:21:18.714396Z";

export const deletableSmokeSequenceIds = Object.freeze([
  "47e4aa8f-274f-438b-b5db-bd21c6958dd8",
  "9693dc11-4a68-4785-ac65-ecdc785d342c",
  "fccef243-c4c9-441a-8bba-563496a91b5e",
]);
export const retainedSmokeSequenceId =
  "8847daf2-3a65-44f3-821e-b491a6c6a877";
export const explicitQaPropertyIds = Object.freeze([
  "35fdf22f-7d43-4de3-8f14-dd3f19e25d63",
  "c0e278db-15f6-4639-aced-283de7d06c58",
  "e14c75d1-d444-4022-ace8-91a40bdd591d",
]);
export const explicitQaContactId =
  "65c13690-2640-4c13-8ff3-dd4db9e93aad";
export const qaMembershipEmails = Object.freeze([
  "browser-v1-owner@bmhgroupkc.com",
  "jarrad+hugo-sops-20260729@bmhgroupkc.com",
  "jarrad+hugo-v1-smoke-20260729@bmhgroupkc.com",
  "sandra-filter-test@bmhgroupkc.com",
]);

const EXPECTED_QA_ADDRESSES = new Map([
  [explicitQaPropertyIds[0], "123 test for QA"],
  [explicitQaPropertyIds[1], "123 QA TEST 2"],
  [explicitQaPropertyIds[2], "001 Test Lead QA"],
]);

const SEMANTIC_DEPENDENCIES = Object.freeze([
  ["messages", "property_id", "properties"],
  ["message_threads", "property_id", "properties"],
  ["call_activities", "property_id", "properties"],
  ["tasks", "related_property_id", "properties"],
  ["sequence_enrollments", "property_id", "properties"],
  ["dialer_batch_items", "property_id", "properties"],
  ["campaign_recipients", "property_id", "properties"],
  ["property_tags", "property_id", "properties"],
  ["property_lists", "property_id", "properties"],
  ["lead_events", "property_id", "properties"],
  ["ai_disposition_reviews", "property_id", "properties"],
  ["ai_response_claims", "property_id", "properties"],
  ["cass_property_lookup_outcomes", "property_id", "properties"],
  ["closer_practice_outcomes", "property_id", "properties"],
  ["coach_call_index", "property_id", "properties"],
  ["csv_import_row_outcomes", "property_id", "properties"],
  ["esign_requests", "property_id", "properties"],
  ["job_items", "property_id", "properties"],
  ["lead_files", "property_id", "properties"],
  ["lead_notes", "property_id", "properties"],
  ["property_merges", "keeper_id", "properties"],
  ["property_merges", "loser_id", "properties"],
  ["sms_inbound_intents", "property_id", "properties"],
  ["properties", "homeowner_contact_id", "contacts"],
  ["properties", "agent_contact_id", "contacts"],
  ["consent_events", "contact_id", "contacts"],
  ["sms_phone_suppressions", "first_contact_id", "contacts"],
  ["agent_details", "contact_id", "contacts"],
  ["ai_response_claims", "contact_id", "contacts"],
  ["call_activities", "contact_id", "contacts"],
  ["campaign_recipients", "contact_id", "contacts"],
  ["closer_practice_outcomes", "contact_id", "contacts"],
  ["csv_import_consent_outcomes", "contact_id", "contacts"],
  ["dialer_batch_items", "contact_id", "contacts"],
  ["homeowner_details", "contact_id", "contacts"],
  ["job_items", "contact_id", "contacts"],
  ["message_threads", "contact_id", "contacts"],
  ["messages", "contact_id", "contacts"],
  ["sequence_enrollments", "contact_id", "contacts"],
  ["sms_inbound_intents", "contact_id", "contacts"],
  ["tasks", "contact_id", "contacts"],
  ["sequence_steps", "sequence_id", "sequences"],
  ["sequence_enrollments", "sequence_id", "sequences"],
  ["csv_import_job_provenance", "sequence_id", "sequences"],
]);

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--env" || token === "--out") {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${token}`);
      result[token.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (!result.out) {
    throw new Error(
      "Usage: export-sandra-cleanup-packet.mjs [--env <file>] --out <new-directory>",
    );
  }
  return result;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedRows(rows) {
  return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function membershipKey(row) {
  return `${row.org_id}:${row.user_id}`;
}

function sortedMembershipRows(rows) {
  return [...rows].sort((a, b) =>
    membershipKey(a).localeCompare(membershipKey(b)),
  );
}

function sortedIds(rows) {
  return sortedRows(rows).map((row) => row.id);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function assertDatabaseTarget(connectionString, expectedRef) {
  const url = new URL(connectionString);
  assert(
    url.protocol === "postgresql:" || url.protocol === "postgres:",
    "Refusing a non-Postgres database URL.",
  );
  assert(
    [...url.searchParams].length === 0 && !url.hash,
    "Refusing database URL query parameters or fragments.",
  );
  const direct =
    url.hostname === `db.${expectedRef}.supabase.co` &&
    decodeURIComponent(url.username) === "postgres";
  const pooler =
    /^aws-[0-9]+-us-east-1\.pooler\.supabase\.com$/u.test(url.hostname) &&
    decodeURIComponent(url.username) === `postgres.${expectedRef}`;
  assert(direct || pooler, "Refusing an unexpected database target.");
  assert(
    !url.pathname || url.pathname === "/postgres",
    "Refusing a non-postgres database target.",
  );
  return { direct, pooler, connectionString: url.toString() };
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function assertNoSymlinkComponents(target) {
  const parsed = path.parse(target);
  const pieces = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const piece of pieces) {
    cursor = path.join(cursor, piece);
    try {
      const stat = await lstat(cursor);
      assert(!stat.isSymbolicLink(), `Refusing symlinked output path: ${target}`);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") break;
      throw error;
    }
  }
}

async function assertOutsideGit(realAncestor, originalTarget) {
  let cursor = realAncestor;
  for (;;) {
    if (await exists(path.join(cursor, ".git"))) {
      throw new Error(
        `Refusing to write a production-data export inside a Git worktree: ${originalTarget}`,
      );
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

export async function assertPrivateOutputPath(outputDir) {
  const resolved = path.resolve(outputDir);
  await assertNoSymlinkComponents(resolved);
  let existing = resolved;
  while (!(await exists(existing))) {
    const parent = path.dirname(existing);
    assert(parent !== existing, "Could not resolve an output-path ancestor.");
    existing = parent;
  }
  const existingStat = await lstat(existing);
  assert(existingStat.isDirectory(), "Output-path ancestor is not a directory.");
  await assertOutsideGit(await realpath(existing), resolved);
  return resolved;
}

export async function writePrivatePacket(outputDir, files) {
  const resolved = await assertPrivateOutputPath(outputDir);
  assert(!(await exists(resolved)), "Output directory already exists.");
  const parent = path.dirname(resolved);
  assert(await exists(parent), "Output directory parent must already exist.");
  let created = false;
  try {
    await mkdir(resolved, { mode: 0o700 });
    created = true;
    await assertPrivateOutputPath(resolved);
    assert((await realpath(resolved)) === resolved, "Output directory changed after creation.");
    for (const [name, contents] of Object.entries(files)) {
      const temporary = path.join(resolved, `.${name}.tmp`);
      await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path.join(resolved, name));
    }
    await chmod(resolved, 0o700);
    return resolved;
  } catch (error) {
    if (created) await rm(resolved, { recursive: true, force: true });
    throw error;
  }
}

async function rows(client, sql, values = []) {
  const result = await client.query(sql, values);
  return result.rows.map((entry) => entry.row ?? entry);
}

async function rowsByIds(client, table, column, ids) {
  if (ids.length === 0) return [];
  return rows(
    client,
    `select to_jsonb(t) as row from public.${quoteIdentifier(table)} t where t.${quoteIdentifier(column)} = any($1::uuid[]) order by to_jsonb(t)::text`,
    [ids],
  );
}

function expectedDependencyIds(packet, signature) {
  const propertyIds = new Set([
    ...sortedIds(packet.syntheticCohort.properties),
    ...sortedIds(packet.explicitQaProperties.properties),
  ]);
  const contactIds = new Set([
    ...sortedIds(packet.syntheticCohort.contacts),
    explicitQaContactId,
  ]);
  const sequenceIds = new Set(deletableSmokeSequenceIds);
  const sources = {
    "properties.homeowner_contact_id->contacts": packet.syntheticCohort.properties
      .concat(packet.explicitQaProperties.properties)
      .filter((row) => contactIds.has(row.homeowner_contact_id)),
    "lead_events.property_id->properties": packet.syntheticCohort.leadEvents.concat(
      packet.explicitQaProperties.leadEvents,
    ),
    "tasks.related_property_id->properties": packet.explicitQaProperties.tasks,
    "sequence_steps.sequence_id->sequences": packet.smokeSequences.steps,
  };
  const expected = sources[signature] ?? [];
  assert(
    expected.every((row) =>
      signature.endsWith("->contacts")
        ? contactIds.has(row.homeowner_contact_id)
        : signature.endsWith("->properties")
          ? propertyIds.has(row.property_id ?? row.related_property_id)
          : sequenceIds.has(row.sequence_id),
    ),
    `Internal dependency expectation failed for ${signature}`,
  );
  return sortedIds(expected);
}

async function dependencyEvidence(client, targetIds, packet) {
  const catalog = await client.query(`
    select
      child_ns.nspname as child_schema,
      child.relname as child_table,
      parent_ns.nspname as parent_schema,
      parent.relname as parent_table,
      child_att.attname as child_column,
      parent_att.attname as parent_column
    from pg_constraint constraint_row
    join pg_class child on child.oid = constraint_row.conrelid
    join pg_namespace child_ns on child_ns.oid = child.relnamespace
    join pg_class parent on parent.oid = constraint_row.confrelid
    join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
    join lateral unnest(constraint_row.conkey, constraint_row.confkey)
      with ordinality as columns(child_num, parent_num, ordinal) on true
    join pg_attribute child_att on child_att.attrelid = child.oid and child_att.attnum = columns.child_num
    join pg_attribute parent_att on parent_att.attrelid = parent.oid and parent_att.attnum = columns.parent_num
    where constraint_row.contype = 'f'
      and parent_ns.nspname = 'public'
      and parent.relname = any($1::text[])
      and parent_att.attname = 'id'
  `, [["contacts", "properties", "sequences"]]);
  const specs = new Map();
  for (const row of catalog.rows) {
    assert(
      row.child_schema === "public",
      "Cleanup target has an unsupported foreign-key shape.",
    );
    specs.set(
      `${row.child_table}.${row.child_column}->${row.parent_table}`,
      [row.child_table, row.child_column, row.parent_table],
    );
  }
  for (const spec of SEMANTIC_DEPENDENCIES) {
    specs.set(`${spec[0]}.${spec[1]}->${spec[2]}`, spec);
  }

  const evidence = [];
  for (const [signature, [table, column, parent]] of [...specs].sort()) {
    const dependencyRows = await rowsByIds(client, table, column, targetIds[parent]);
    const actualIds = sortedIds(dependencyRows);
    const expectedIds = expectedDependencyIds(packet, signature);
    assert(
      JSON.stringify(actualIds) === JSON.stringify(expectedIds),
      `Dependency drift for ${signature}: expected ${expectedIds.length}, got ${actualIds.length}`,
    );
    evidence.push({
      signature,
      rowCount: dependencyRows.length,
      rows: sortedRows(dependencyRows),
      rowsSha256: sha256(JSON.stringify(sortedRows(dependencyRows))),
    });
  }
  return evidence;
}

export async function buildCleanupPacket(client, generatedAt = new Date().toISOString()) {
  const snapshotResult = await client.query(
    "select txid_current_snapshot() as snapshot, current_database() as database_name, current_user as database_user",
  );
  const snapshot = snapshotResult.rows[0];
  assert(snapshot.database_name === "postgres", "Unexpected database name.");

  const syntheticProperties = await rows(
    client,
    `select to_jsonb(p) as row from public.properties p
     where p.org_id=$1 and p.market='Synthetic Test' and p.source='driving_for_dollars'
       and p.deleted_at=$2::timestamptz and p.created_at >= $3::timestamptz and p.created_at < $4::timestamptz
     order by p.id`,
    [EXPECTED_ORG_ID, SYNTHETIC_DELETED_AT, SYNTHETIC_CREATED_FROM, SYNTHETIC_CREATED_TO],
  );
  assert(syntheticProperties.length === 1326, "Synthetic property count drifted.");
  const syntheticContactIds = syntheticProperties
    .map((row) => row.homeowner_contact_id)
    .filter(Boolean)
    .sort();
  assert(new Set(syntheticContactIds).size === 1326, "Synthetic contact identity drifted.");
  const syntheticContacts = await rowsByIds(client, "contacts", "id", syntheticContactIds);
  const syntheticEvents = await rowsByIds(
    client,
    "lead_events",
    "property_id",
    sortedIds(syntheticProperties),
  );
  assert(syntheticContacts.length === 1326, "Synthetic contact count drifted.");
  assert(syntheticEvents.length === 1326, "Synthetic event count drifted.");
  assert(
    syntheticContacts.every((row) =>
      row.notes?.startsWith("jitter-test-r1-apify-full-rotation;"),
    ) &&
      syntheticProperties.every((row) =>
        row.notes?.startsWith("jitter-test-r1-apify-full-rotation;"),
      ),
    "Synthetic provenance marker changed.",
  );

  const explicitQaProperties = await rowsByIds(
    client,
    "properties",
    "id",
    explicitQaPropertyIds,
  );
  assert(explicitQaProperties.length === 3, "Explicit QA property count drifted.");
  assert(
    explicitQaProperties.every(
      (row) =>
        row.org_id === EXPECTED_ORG_ID &&
        row.deleted_at === null &&
        row.is_dnc_locked === false &&
        EXPECTED_QA_ADDRESSES.get(row.id) === row.address,
    ),
    "Explicit QA property provenance changed.",
  );
  const explicitQaContactIds = [
    ...new Set(explicitQaProperties.map((row) => row.homeowner_contact_id).filter(Boolean)),
  ].sort();
  const explicitQaContacts = await rowsByIds(
    client,
    "contacts",
    "id",
    explicitQaContactIds,
  );
  const explicitQaEvents = await rowsByIds(
    client,
    "lead_events",
    "property_id",
    explicitQaPropertyIds,
  );
  const explicitQaTasks = await rowsByIds(
    client,
    "tasks",
    "related_property_id",
    explicitQaPropertyIds,
  );
  assert(explicitQaContacts.some((row) => row.id === explicitQaContactId), "Deletable QA contact is missing.");
  assert(explicitQaEvents.length === 4 && explicitQaTasks.length === 1, "Explicit QA child rows drifted.");

  const smokeSequences = await rowsByIds(
    client,
    "sequences",
    "id",
    deletableSmokeSequenceIds,
  );
  const smokeSteps = await rowsByIds(
    client,
    "sequence_steps",
    "sequence_id",
    deletableSmokeSequenceIds,
  );
  const smokeEnrollments = await rowsByIds(
    client,
    "sequence_enrollments",
    "sequence_id",
    deletableSmokeSequenceIds,
  );
  assert(smokeSequences.length === 3 && smokeSteps.length === 3 && smokeEnrollments.length === 0, "Smoke sequence counts drifted.");
  assert(
    smokeSequences.every(
      (row) =>
        row.org_id === EXPECTED_ORG_ID &&
        row.active === true &&
        row.archived_at === null &&
        row.name?.startsWith("SMOKE TEST — safe to delete ") &&
        row.description === "One-off prod smoke; script deletes this when it exits",
    ),
    "Deletable smoke sequence provenance changed.",
  );

  const retainedSmokeSequences = await rowsByIds(client, "sequences", "id", [
    retainedSmokeSequenceId,
  ]);
  const retainedSmokeSteps = await rowsByIds(client, "sequence_steps", "sequence_id", [
    retainedSmokeSequenceId,
  ]);
  const retainedSmokeEnrollments = await rowsByIds(
    client,
    "sequence_enrollments",
    "sequence_id",
    [retainedSmokeSequenceId],
  );
  assert(
    retainedSmokeSequences.length === 1 &&
      retainedSmokeSteps.length === 1 &&
      retainedSmokeEnrollments.length === 3 &&
      retainedSmokeEnrollments.every((row) => row.status === "completed"),
    "Retained smoke sequence history drifted.",
  );
  assert(
    retainedSmokeSequences.every(
      (row) =>
        row.org_id === EXPECTED_ORG_ID &&
        row.active === true &&
        row.archived_at === null &&
        row.name?.startsWith("SMOKE TEST — safe to delete ") &&
        row.description === "One-off prod smoke; script deletes this when it exits",
    ),
    "Retained smoke sequence provenance changed.",
  );

  const qaMembershipResult = await client.query(
    `select to_jsonb(m) as row, u.email
     from public.memberships m
     join auth.users u on u.id=m.user_id
     where lower(u.email)=any($1::text[])
     order by m.org_id, m.user_id`,
    [qaMembershipEmails],
  );
  const qaMemberships = qaMembershipResult.rows.map((entry) => entry.row);
  assert(qaMemberships.length === 4, "QA membership count drifted.");
  assert(
    qaMembershipResult.rows.every(
      (entry) =>
        entry.row.org_id === EXPECTED_ORG_ID &&
        qaMembershipEmails.includes(entry.email.toLowerCase()),
    ),
    "QA membership scope drifted.",
  );
  assert(
    qaMembershipResult.rows.filter(
      (entry) => entry.row.access_status === "active",
    ).length === 2 &&
      qaMembershipResult.rows.filter(
        (entry) => entry.row.access_status === "suspended",
      ).length === 2,
    "QA membership lifecycle drifted.",
  );

  const packet = {
    format: "sandra-cleanup-packet-v2",
    generatedAt,
    snapshot,
    target: { projectRef: EXPECTED_PROJECT_REF, orgId: EXPECTED_ORG_ID },
    syntheticCohort: {
      predicate: {
        market: "Synthetic Test",
        source: "driving_for_dollars",
        provenancePrefix: "jitter-test-r1-apify-full-rotation;",
        createdAtGte: SYNTHETIC_CREATED_FROM,
        createdAtLt: SYNTHETIC_CREATED_TO,
        deletedAt: SYNTHETIC_DELETED_AT,
      },
      contacts: sortedRows(syntheticContacts),
      properties: sortedRows(syntheticProperties),
      leadEvents: sortedRows(syntheticEvents),
    },
    explicitQaProperties: {
      deletableContactId: explicitQaContactId,
      contacts: sortedRows(explicitQaContacts),
      properties: sortedRows(explicitQaProperties),
      leadEvents: sortedRows(explicitQaEvents),
      tasks: sortedRows(explicitQaTasks),
    },
    smokeSequences: {
      sequences: sortedRows(smokeSequences),
      steps: sortedRows(smokeSteps),
      enrollments: [],
    },
    retainedSmokeSequenceToArchive: {
      sequences: sortedRows(retainedSmokeSequences),
      steps: sortedRows(retainedSmokeSteps),
      enrollments: sortedRows(retainedSmokeEnrollments),
    },
    qaMembershipAccessReview: {
      decision: "separate_fable_approval_required",
      scope: "membership rows only; auth identities and audit history retained",
      emails: [...qaMembershipEmails],
      memberships: sortedMembershipRows(qaMemberships),
    },
  };
  packet.dependencies = await dependencyEvidence(
    client,
    {
      contacts: [...syntheticContactIds, explicitQaContactId],
      properties: [...sortedIds(syntheticProperties), ...explicitQaPropertyIds],
      sequences: [...deletableSmokeSequenceIds],
    },
    packet,
  );
  return packet;
}

export function buildManifest(packet) {
  const exportJson = `${JSON.stringify(packet, null, 2)}\n`;
  const rowGroups = {
    syntheticContacts: packet.syntheticCohort.contacts,
    syntheticProperties: packet.syntheticCohort.properties,
    syntheticLeadEvents: packet.syntheticCohort.leadEvents,
    explicitQaContacts: packet.explicitQaProperties.contacts,
    explicitQaProperties: packet.explicitQaProperties.properties,
    explicitQaLeadEvents: packet.explicitQaProperties.leadEvents,
    explicitQaTasks: packet.explicitQaProperties.tasks,
    smokeSequences: packet.smokeSequences.sequences,
    smokeSteps: packet.smokeSequences.steps,
    smokeEnrollments: packet.smokeSequences.enrollments,
    retainedSmokeSequences: packet.retainedSmokeSequenceToArchive.sequences,
    retainedSmokeSteps: packet.retainedSmokeSequenceToArchive.steps,
    retainedSmokeEnrollments: packet.retainedSmokeSequenceToArchive.enrollments,
  };
  const membershipRows = packet.qaMembershipAccessReview?.memberships ?? [];
  const idSets = Object.fromEntries(
    Object.entries(rowGroups).map(([key, value]) => [key, sortedIds(value)]),
  );
  idSets.qaMemberships = sortedMembershipRows(membershipRows).map(membershipKey);
  const manifest = {
    format: packet.format,
    generatedAt: packet.generatedAt,
    snapshot: packet.snapshot,
    target: packet.target,
    exportSha256: sha256(exportJson),
    counts: Object.fromEntries(
      Object.entries(rowGroups).map(([key, value]) => [key, value.length]),
    ),
    idSets,
    idSetSha256: Object.fromEntries(
      Object.entries(idSets).map(([key, ids]) => [
        key,
        sha256(ids.join(",")),
      ]),
    ),
    dependencyCounts: Object.fromEntries(
      packet.dependencies.map((dependency) => [dependency.signature, dependency.rowCount]),
    ),
    dependencySha256: Object.fromEntries(
      packet.dependencies.map((dependency) => [dependency.signature, dependency.rowsSha256]),
    ),
    stablePayloadSha256: sha256(
      JSON.stringify({ ...packet, generatedAt: null, snapshot: null }),
    ),
  };
  manifest.counts.qaMemberships = membershipRows.length;
  return { exportJson, manifest };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.env) process.loadEnvFile(path.resolve(args.env));
  const connectionString = process.env[DATABASE_URL_ENV];
  assert(connectionString, `${DATABASE_URL_ENV} is missing.`);
  const target = assertDatabaseTarget(connectionString, EXPECTED_PROJECT_REF);

  const client = new Client({
    connectionString: target.connectionString,
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();
  let packet;
  try {
    await client.query("begin isolation level repeatable read read only");
    packet = await buildCleanupPacket(client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  const { exportJson, manifest } = buildManifest(packet);
  const outputDir = await writePrivatePacket(args.out, {
    "packet-a-export.json": exportJson,
    "packet-a-manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
  });
  process.stdout.write(
    `${JSON.stringify({ outputDir, exportSha256: manifest.exportSha256, stablePayloadSha256: manifest.stablePayloadSha256, counts: manifest.counts, dependencyCounts: manifest.dependencyCounts })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
