#!/usr/bin/env tsx
/**
 * npm run replay:export -- --db-url <source-db-url> [--days 30] [--context-days 60]
 *                          [--org <uuid>] [--batch <id>] [--out <file>] [--mask-pii (default) | --no-mask-pii]
 *
 * READ-ONLY export of the last N days of inbound SMS plus the minimal context
 * rows they need, with every seller phone masked, into tmp/replay/<batch>.json.
 * Runs in `begin transaction read only` with a statement timeout; Postgres
 * rejects any write. The source may be production: it is only ever read.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { Client } from "pg";

import { assertBatchId, exportPathFor, fail, loadMaskSalt, redactDbUrl, REPLAY_DIR } from "./cli";
import { withReadOnlyTransaction } from "./db";
import { buildExport } from "./export-core";

async function main() {
  const { values } = parseArgs({
    options: {
      "db-url": { type: "string" },
      days: { type: "string", default: "30" },
      "context-days": { type: "string", default: "60" },
      org: { type: "string" },
      batch: { type: "string" },
      out: { type: "string" },
      "mask-pii": { type: "boolean", default: true },
      "no-mask-pii": { type: "boolean", default: false },
      "statement-timeout-ms": { type: "string", default: "120000" },
    },
  });
  const dbUrl = values["db-url"] ?? process.env.REPLAY_SOURCE_DB_URL;
  if (!dbUrl) fail("--db-url (or REPLAY_SOURCE_DB_URL) is required");
  const days = Number(values.days);
  const contextDays = Number(values["context-days"]);
  if (!Number.isFinite(days) || days < 1 || days > 120) fail("--days must be 1..120");
  if (!Number.isFinite(contextDays) || contextDays < 0 || contextDays > 365) fail("--context-days must be 0..365");

  const now = new Date();
  const batchId = assertBatchId(values.batch ?? now.toISOString().slice(0, 10));
  const out = values.out ? path.resolve(values.out) : exportPathFor(batchId);

  console.log(`export: source ${redactDbUrl(dbUrl)} (read-only transaction)`);
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const result = await withReadOnlyTransaction(
      client,
      (query) =>
        buildExport(query, {
          batchId,
          days,
          contextDays,
          orgId: values.org ?? null,
          now,
          salt: loadMaskSalt(),
          maskPii: !values["no-mask-pii"],
          businessNumbers: process.env.SENDILLO_FROM_NUMBER ? [process.env.SENDILLO_FROM_NUMBER] : [],
        }),
      { statementTimeoutMs: Number(values["statement-timeout-ms"]) },
    );
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(`export: wrote ${out}`);
    for (const [key, n] of Object.entries(result.counts)) console.log(`  ${key.padEnd(24)} ${n}`);
    console.log(`  window                   ${result.window.start} .. ${result.window.end}`);
    console.log(`  batch id                 ${result.batchId} (data dir ${REPLAY_DIR})`);
  } finally {
    await client.end();
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
