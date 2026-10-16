#!/usr/bin/env tsx
/**
 * npm run replay:run -- --batch <id> [--speed 10 | --burst] [--max-gap-seconds 30]
 *                       [--limit N] [--since ISO] [--base-url http://localhost:3101]
 *
 * Replays the export's inbound SMS in original order through the real Sendillo
 * webhook route of a LOCAL Sandra server started with `npm run replay:server`
 * (SMS_PROVIDER_STUB=1). Refuses, before sending anything, unless: the base URL
 * is localhost, Supabase/DB are not production, this process holds no Sendillo
 * key, and the server itself proves it is stubbed. Writes a summary JSON.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";

import { Client } from "pg";

import { DEFAULT_LOCAL_DB_URL, DEFAULT_REPLAY_WEBHOOK_SECRET, REPLAY_DIR, assertBatchId, exportPathFor, fail, loadExport } from "./cli";
import { assertStaticSafety, runReplay, type Deps, type RunOptions } from "./run-core";
import { readProdRefs } from "./safety";

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      batch: { type: "string" },
      "base-url": { type: "string", default: "http://localhost:3101" },
      "supabase-url": { type: "string" },
      "db-url": { type: "string" },
      "allow-project-ref": { type: "string" },
      speed: { type: "string", default: "1" },
      burst: { type: "boolean", default: false },
      "max-gap-seconds": { type: "string", default: "0" },
      limit: { type: "string" },
      since: { type: "string" },
      "run-timeout-seconds": { type: "string", default: "180" },
      out: { type: "string" },
    },
  });
  const file = values.file ?? (values.batch ? exportPathFor(assertBatchId(values.batch)) : null);
  if (!file) fail("--file <export.json> or --batch <id> is required");
  const exp = loadExport(file);

  const speed = Number(values.speed);
  if (!Number.isFinite(speed) || speed <= 0) fail("--speed must be a positive number");

  const opts: RunOptions = {
    baseUrl: values["base-url"]!,
    supabaseUrl: values["supabase-url"] ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54331",
    dbUrl: values["db-url"] ?? process.env.SUPABASE_LOCAL_DB_URL ?? DEFAULT_LOCAL_DB_URL,
    allowProjectRef: values["allow-project-ref"] ?? null,
    prodRefs: readProdRefs(process.cwd()),
    webhookSecret: process.env.SENDILLO_WEBHOOK_SECRET || DEFAULT_REPLAY_WEBHOOK_SECRET,
    speed,
    burst: values.burst,
    maxGapSeconds: Number(values["max-gap-seconds"]),
    limit: values.limit ? Number(values.limit) : null,
    since: values.since ?? null,
    runTimeoutMs: Number(values["run-timeout-seconds"]) * 1000,
    pollMs: 500,
  };

  try {
    assertStaticSafety(opts, process.env); // before any connection is opened
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const client = new Client({ connectionString: opts.dbUrl });
  const deps: Deps = {
    env: process.env,
    fetch,
    query: (sql, params) => client.query(sql, params as never[]) as never,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (line) => console.log(line),
  };

  const runId = randomBytes(3).toString("hex");
  try {
    // Safety checks live in preflight(); connect only after the pure URL checks it performs first.
    await client.connect();
    console.log(`replay: batch ${exp.batchId} run ${runId} -> ${opts.baseUrl} (${exp.inbound.length} inbound, ${opts.burst ? "burst" : `speed ${speed}x`})`);
    const { summary } = await runReplay(exp, opts, deps, runId);
    const out = values.out ? path.resolve(values.out) : path.join(REPLAY_DIR, `${exp.batchId}.summary.${runId}.json`);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(summary, null, 2));
    console.log(`replay: done. auto=${summary.auto} held=${summary.held} would-have-sent=${summary.wouldHaveSent} failures=${summary.failures.length} dead-letters=${summary.deadLetters.length}`);
    console.log(`replay: summary ${out}`);
    if (summary.failures.length > 0) process.exitCode = 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
