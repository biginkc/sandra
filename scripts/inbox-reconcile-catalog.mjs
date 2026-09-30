#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Client } from "pg";

import { catalogFingerprint } from "./inbox-reconcile-completion.mjs";

const MIGRATION_FILES = Object.freeze([
  "20260930040000_inbox_control_foundation.sql",
  "20260930040100_inbox_read_companion.sql",
  "20260930040200_inbox_backend_operation_reply.sql",
]);
const OUTPUT = path.resolve("scripts/inbox-reconcile-catalog.expected.json");

function migrationCommit() {
  const value = process.env.INBOX_RECONCILIATION_MIGRATION_COMMIT ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error("INBOX_RECONCILIATION_MIGRATION_COMMIT must be a full 40-hex commit");
  return value;
}

function migrationHashes() {
  return MIGRATION_FILES.map((file) => {
    const relative = path.join("supabase", "migrations", file);
    const bytes = readFileSync(relative);
    return { path: file, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

function localDsn() {
  const dsn = process.env.INBOX_RECONCILIATION_TEST_DATABASE_URL;
  if (!dsn) throw new Error("INBOX_RECONCILIATION_TEST_DATABASE_URL_REQUIRED");
  const url = new URL(dsn);
  if (!(["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error("CATALOG_GENERATOR_LOCAL_DATABASE_ONLY");
  return dsn;
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== "--output" && arg !== OUTPUT)) throw new Error(`Only --output ${OUTPUT} is supported`);
  const dsn = localDsn();
  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    const artifact = {
      artifact_version: 1,
      catalog_fingerprint: await catalogFingerprint(client),
      source: {
        kind: "independent-committed-catalog-artifact",
        migration_commit: migrationCommit(),
        migration_files: migrationHashes(),
      },
    };
    writeFileSync(OUTPUT, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ output: OUTPUT, catalog_fingerprint: artifact.catalog_fingerprint })}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
