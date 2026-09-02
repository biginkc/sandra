#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";

const EXPECTED_PROJECT_REF = "copflsklaefwzipsrjqz";
const EXPECTED_ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const SYNTHETIC_CREATED_FROM = "2026-05-15T04:02:54.000Z";
const SYNTHETIC_CREATED_TO = "2026-05-15T04:02:56.000Z";
const SYNTHETIC_DELETED_AT = "2026-06-17T18:21:18.714396Z";

const deletableSmokeSequenceIds = [
  "47e4aa8f-274f-438b-b5db-bd21c6958dd8",
  "9693dc11-4a68-4785-ac65-ecdc785d342c",
  "fccef243-c4c9-441a-8bba-563496a91b5e",
];
const retainedSmokeSequenceId = "8847daf2-3a65-44f3-821e-b491a6c6a877";

const explicitQaPropertyIds = [
  "35fdf22f-7d43-4de3-8f14-dd3f19e25d63",
  "c0e278db-15f6-4639-aced-283de7d06c58",
  "e14c75d1-d444-4022-ace8-91a40bdd591d",
];

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
  if (!result.env || !result.out) {
    throw new Error(
      "Usage: export-sandra-cleanup-packet.mjs --env <file> --out <directory>",
    );
  }
  return result;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortedIds(rows) {
  return rows.map((row) => row.id).sort();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function queryAll(buildQuery, pageSize = 500) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

async function queryByIds(client, table, column, ids, select = "*") {
  const rows = [];
  const chunkSize = 150;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize);
    for (let from = 0; ; from += 500) {
      const { data, error } = await client
        .from(table)
        .select(select)
        .in(column, chunk)
        .order("id", { ascending: true })
        .range(from, from + 499);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 500) break;
    }
  }
  return rows;
}

export async function assertPrivateOutputPath(outputDir) {
  let cursor = outputDir;
  for (;;) {
    try {
      await access(path.join(cursor, ".git"));
      throw new Error(
        `Refusing to write a production-data export inside a Git worktree: ${outputDir}`,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Refusing to write")
      )
        throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.loadEnvFile(path.resolve(args.env));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert(
    url && serviceRoleKey,
    "Production Supabase URL or service-role credential is missing",
  );

  const hostname = new URL(url).hostname;
  assert(
    hostname === `${EXPECTED_PROJECT_REF}.supabase.co`,
    `Refusing unexpected database target: ${hostname}`,
  );

  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const syntheticProperties = await queryAll(() =>
    client
      .from("properties")
      .select("*")
      .eq("org_id", EXPECTED_ORG_ID)
      .eq("market", "Synthetic Test")
      .eq("source", "driving_for_dollars")
      .eq("deleted_at", SYNTHETIC_DELETED_AT)
      .gte("created_at", SYNTHETIC_CREATED_FROM)
      .lt("created_at", SYNTHETIC_CREATED_TO)
      .order("id", { ascending: true }),
  );
  assert(
    syntheticProperties.length === 1326,
    `Expected 1326 synthetic properties; got ${syntheticProperties.length}`,
  );

  const syntheticContactIds = [
    ...new Set(syntheticProperties.map((row) => row.homeowner_contact_id)),
  ]
    .filter(Boolean)
    .sort();
  assert(
    syntheticContactIds.length === 1326,
    `Expected 1326 synthetic contacts; got ${syntheticContactIds.length}`,
  );

  const syntheticContacts = await queryByIds(
    client,
    "contacts",
    "id",
    syntheticContactIds,
  );
  const syntheticEvents = await queryByIds(
    client,
    "lead_events",
    "property_id",
    sortedIds(syntheticProperties),
  );
  assert(
    syntheticContacts.length === 1326,
    `Expected 1326 contact rows; got ${syntheticContacts.length}`,
  );
  assert(
    syntheticEvents.length === 1326,
    `Expected 1326 lead events; got ${syntheticEvents.length}`,
  );
  assert(
    syntheticContacts.every((row) =>
      row.notes?.startsWith("jitter-test-r1-apify-full-rotation;"),
    ),
    "Synthetic contact provenance marker changed",
  );
  assert(
    syntheticProperties.every((row) =>
      row.notes?.startsWith("jitter-test-r1-apify-full-rotation;"),
    ),
    "Synthetic property provenance marker changed",
  );

  const explicitQaProperties = await queryByIds(
    client,
    "properties",
    "id",
    explicitQaPropertyIds,
  );
  assert(
    explicitQaProperties.length === explicitQaPropertyIds.length,
    "An explicit QA property is missing",
  );
  assert(
    explicitQaProperties.every(
      (row) =>
        row.org_id === EXPECTED_ORG_ID &&
        row.deleted_at === null &&
        row.is_dnc_locked === false &&
        row.created_at >= "2026-09-01T20:06:28.000000+00:00" &&
        row.created_at < "2026-09-02T16:42:39.000000+00:00",
    ),
    "Explicit QA property scope or lifecycle changed",
  );
  const expectedQaAddresses = new Map([
    ["35fdf22f-7d43-4de3-8f14-dd3f19e25d63", "123 test for QA"],
    ["c0e278db-15f6-4639-aced-283de7d06c58", "123 QA TEST 2"],
    ["e14c75d1-d444-4022-ace8-91a40bdd591d", "001 Test Lead QA"],
  ]);
  assert(
    explicitQaProperties.every(
      (row) => expectedQaAddresses.get(row.id) === row.address,
    ),
    "Explicit QA identity/provenance changed",
  );
  const explicitQaContactIds = [
    ...new Set(explicitQaProperties.map((row) => row.homeowner_contact_id)),
  ]
    .filter(Boolean)
    .sort();
  const explicitQaContacts = await queryByIds(
    client,
    "contacts",
    "id",
    explicitQaContactIds,
  );
  const explicitQaEvents = await queryByIds(
    client,
    "lead_events",
    "property_id",
    explicitQaPropertyIds,
  );
  const explicitQaTasks = await queryByIds(
    client,
    "tasks",
    "related_property_id",
    explicitQaPropertyIds,
  );

  const smokeSequences = await queryByIds(
    client,
    "sequences",
    "id",
    deletableSmokeSequenceIds,
  );
  const smokeSequenceIds = sortedIds(smokeSequences);
  assert(
    JSON.stringify(smokeSequenceIds) ===
      JSON.stringify([...deletableSmokeSequenceIds].sort()),
    "Deletable smoke sequence allowlist drifted",
  );
  assert(
    smokeSequences.every(
      (row) =>
        row.org_id === EXPECTED_ORG_ID &&
        row.active === true &&
        row.archived_at === null &&
        row.name?.startsWith("SMOKE TEST — safe to delete ") &&
        row.description ===
          "One-off prod smoke; script deletes this when it exits",
    ),
    "Deletable smoke sequence provenance or lifecycle changed",
  );
  const smokeSteps = await queryByIds(
    client,
    "sequence_steps",
    "sequence_id",
    smokeSequenceIds,
  );
  const smokeEnrollments = await queryByIds(
    client,
    "sequence_enrollments",
    "sequence_id",
    smokeSequenceIds,
  );
  assert(
    smokeSteps.length === 3,
    `Expected 3 deletable smoke steps; got ${smokeSteps.length}`,
  );
  assert(
    smokeEnrollments.length === 0,
    "A deletable smoke sequence gained enrollment history",
  );

  const retainedSmokeSequences = await queryByIds(client, "sequences", "id", [
    retainedSmokeSequenceId,
  ]);
  const retainedSmokeSteps = await queryByIds(
    client,
    "sequence_steps",
    "sequence_id",
    [retainedSmokeSequenceId],
  );
  const retainedSmokeEnrollments = await queryByIds(
    client,
    "sequence_enrollments",
    "sequence_id",
    [retainedSmokeSequenceId],
  );
  assert(
    retainedSmokeSequences.length === 1,
    "Retained smoke sequence is missing",
  );
  assert(
    retainedSmokeEnrollments.length === 3,
    "Retained smoke enrollment history drifted",
  );

  const exportPayload = {
    format: "sandra-cleanup-packet-v1",
    generatedAt: new Date().toISOString(),
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
      contacts: syntheticContacts.sort((a, b) => a.id.localeCompare(b.id)),
      properties: syntheticProperties,
      leadEvents: syntheticEvents.sort((a, b) => a.id.localeCompare(b.id)),
    },
    explicitQaProperties: {
      contacts: explicitQaContacts.sort((a, b) => a.id.localeCompare(b.id)),
      properties: explicitQaProperties.sort((a, b) => a.id.localeCompare(b.id)),
      leadEvents: explicitQaEvents.sort((a, b) => a.id.localeCompare(b.id)),
      tasks: explicitQaTasks.sort((a, b) => a.id.localeCompare(b.id)),
    },
    smokeSequences: {
      sequences: smokeSequences,
      steps: smokeSteps.sort((a, b) => a.id.localeCompare(b.id)),
      enrollments: smokeEnrollments.sort((a, b) => a.id.localeCompare(b.id)),
    },
    retainedSmokeSequenceToArchive: {
      sequences: retainedSmokeSequences,
      steps: retainedSmokeSteps.sort((a, b) => a.id.localeCompare(b.id)),
      enrollments: retainedSmokeEnrollments.sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    },
  };

  const exportJson = `${JSON.stringify(exportPayload, null, 2)}\n`;
  const manifest = {
    format: exportPayload.format,
    generatedAt: exportPayload.generatedAt,
    target: exportPayload.target,
    exportSha256: sha256(exportJson),
    counts: {
      syntheticContacts: syntheticContacts.length,
      syntheticProperties: syntheticProperties.length,
      syntheticLeadEvents: syntheticEvents.length,
      explicitQaContacts: explicitQaContacts.length,
      explicitQaProperties: explicitQaProperties.length,
      explicitQaLeadEvents: explicitQaEvents.length,
      explicitQaTasks: explicitQaTasks.length,
      smokeSequences: smokeSequences.length,
      smokeSteps: smokeSteps.length,
      smokeEnrollments: smokeEnrollments.length,
      retainedSmokeSequences: retainedSmokeSequences.length,
      retainedSmokeSteps: retainedSmokeSteps.length,
      retainedSmokeEnrollments: retainedSmokeEnrollments.length,
    },
    idSets: {
      syntheticContacts: syntheticContactIds,
      syntheticProperties: sortedIds(syntheticProperties),
      syntheticLeadEvents: sortedIds(syntheticEvents),
      explicitQaContacts: explicitQaContactIds,
      explicitQaProperties: sortedIds(explicitQaProperties),
      explicitQaLeadEvents: sortedIds(explicitQaEvents),
      explicitQaTasks: sortedIds(explicitQaTasks),
      smokeSequences: smokeSequenceIds,
      smokeSteps: sortedIds(smokeSteps),
      smokeEnrollments: sortedIds(smokeEnrollments),
      retainedSmokeSequences: sortedIds(retainedSmokeSequences),
      retainedSmokeSteps: sortedIds(retainedSmokeSteps),
      retainedSmokeEnrollments: sortedIds(retainedSmokeEnrollments),
    },
  };
  manifest.idSetSha256 = Object.fromEntries(
    Object.entries(manifest.idSets).map(([key, ids]) => [
      key,
      sha256(ids.join(",")),
    ]),
  );
  manifest.stablePayloadSha256 = sha256(
    JSON.stringify({ ...exportPayload, generatedAt: null }),
  );

  const outputDir = path.resolve(args.out);
  await assertPrivateOutputPath(outputDir);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(outputDir, "packet-a-export.json"), exportJson, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    path.join(outputDir, "packet-a-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      flag: "wx",
      mode: 0o600,
    },
  );

  process.stdout.write(
    `${JSON.stringify({ outputDir, exportSha256: manifest.exportSha256, counts: manifest.counts })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
