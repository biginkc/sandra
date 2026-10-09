#!/usr/bin/env tsx
/**
 * npm run replay:seed -- [--file tmp/replay/<batch>.json] [--db-url <local-db>]
 *                        [--supabase-url <local-api>] [--allow-project-ref <ref>]
 *                        [--owner-user <auth-user-uuid>] [--keep-reply-delay]
 * npm run replay:wipe -- --batch <id> [--db-url ...]        (same script, --wipe)
 *
 * Loads an export into the LOCAL/TEST database under a dedicated replay org,
 * idempotently, tagging every row with its batch. --wipe removes it all.
 * Refuses any database that is not loopback / an explicitly allowed non-production project.
 */
import { parseArgs } from "node:util";

import { Client } from "pg";

import { DEFAULT_LOCAL_DB_URL, assertBatchId, exportPathFor, fail, loadExport, redactDbUrl } from "./cli";
import { withTransaction } from "./db";
import { assertSafeDbUrl, assertSafeSupabaseUrl, readProdRefs } from "./safety";
import { seedExport, wipeBatch } from "./seed-core";

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      batch: { type: "string" },
      "db-url": { type: "string" },
      "supabase-url": { type: "string" },
      "allow-project-ref": { type: "string" },
      "owner-user": { type: "string" },
      "keep-reply-delay": { type: "boolean", default: false },
      wipe: { type: "boolean", default: false },
    },
  });

  const dbUrl = values["db-url"] ?? process.env.SUPABASE_LOCAL_DB_URL ?? DEFAULT_LOCAL_DB_URL;
  const prodRefs = readProdRefs(process.cwd());
  const allowProjectRef = values["allow-project-ref"] ?? null;
  const supabaseUrl = values["supabase-url"] ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54331";
  try {
    assertSafeSupabaseUrl(supabaseUrl, { prodRefs, allowProjectRef });
    assertSafeDbUrl(dbUrl, { prodRefs, allowProjectRef });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    if (values.wipe) {
      const batchId = assertBatchId(values.batch ?? (values.file ? loadExport(values.file).batchId : ""));
      console.log(`wipe: target ${redactDbUrl(dbUrl)} batch ${batchId}`);
      const summary = await withTransaction(client, (query) => wipeBatch(query, batchId));
      console.log(`wipe: deleted ${summary.deletedRows} rows in ${summary.passes} pass(es); org ${summary.orgId} removed; 0 tagged rows remain`);
      return;
    }

    const file = values.file ?? (values.batch ? exportPathFor(assertBatchId(values.batch)) : null);
    if (!file) fail("--file <export.json> or --batch <id> is required");
    const exp = loadExport(file);
    console.log(`seed: target ${redactDbUrl(dbUrl)} batch ${exp.batchId} (${exp.inbound.length} inbound to replay)`);
    const summary = await withTransaction(client, (query) =>
      seedExport(query, exp, { ownerUserId: values["owner-user"] ?? null, keepReplyDelay: values["keep-reply-delay"] }),
    );
    console.log(`seed: replay org ${summary.orgId}`);
    for (const [table, n] of Object.entries(summary.inserted)) console.log(`  ${table.padEnd(24)} +${n}`);
    console.log(`  tagged rows              ${summary.tagged}`);
    for (const w of summary.warnings) console.warn(`  warning: ${w}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
