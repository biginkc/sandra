#!/usr/bin/env tsx
/**
 * Routing v2 backfill: give the backlog of unanswered seller texts (last 60 days, no later
 * outbound) the same routing v2 treatment as a live reply. Run sequence and safety notes:
 * docs/routing-v2-backfill.md.
 *
 *   node --conditions=react-server --import tsx scripts/routing-v2-backfill.ts \
 *     --org <uuid> [--dry-run | --classify-only | --apply] [--run-id <id> | --resume <id>] \
 *     [--limit N] [--max-age-days 60] [--text-max-age-days 14] [--batch-max-age-days 14] [--rate 60] [--force-flags] \
 *     [--out <dir>] [--i-know-this-is-prod]
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (createAdminClient). Never prints a
 * secret, a phone number or a message body. A non-local Supabase URL is refused unless
 * --i-know-this-is-prod AND an explicit run id are given.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { ArgError, guardTarget, parseArgs } from "../src/lib/routing-v2-backfill/args";
import { candidatesCsv, itemsCsv, markdownReport, skippedCsv } from "../src/lib/routing-v2-backfill/report";
import { BackfillRefusal, runBackfill } from "../src/lib/routing-v2-backfill/run";
import { adminClientTargetUrl, createAdminClient } from "../src/lib/supabase/admin";

function gitSha(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

/** The database side's clock, from the API gateway's Date header (seconds precision). */
async function dbNowMs(): Promise<number> {
  const url = adminClientTargetUrl() ?? "";
  const res = await fetch(`${url}/rest/v1/`, { method: "HEAD", headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "" } });
  const date = Date.parse(res.headers.get("date") ?? "");
  if (Number.isNaN(date)) throw new Error("database clock unreadable (no Date header)");
  return date;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Guard the URL the admin client will actually connect to (Astra review 4), not a guess.
  const target = adminClientTargetUrl();
  const { runId, prod } = guardTarget(args, target, new Date().toISOString());
  const sha = gitSha();
  const outDir = resolve(args.outDir ?? join(tmpdir(), "routing-v2-backfill", runId), args.mode);
  console.log(`routing v2 backfill: mode=${args.mode} run=${runId} org=${args.orgId} target=${prod ? "PRODUCTION" : "local"} sha=${sha}`);

  const result = await runBackfill(createAdminClient(), {
    orgId: args.orgId,
    mode: args.mode,
    runId,
    maxAgeDays: args.maxAgeDays,
    textMaxAgeDays: args.textMaxAgeDays,
    ratePerMinute: args.ratePerMinute,
    forceFlags: args.forceFlags,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.batchMaxAgeDays !== undefined ? { batchMaxAgeDays: args.batchMaxAgeDays } : {}),
  }, {
    // Only reached by the legacy generation path, which a v2-live property never takes. Dry-run
    // dispatches nothing, so it needs no key.
    anthropic: args.mode === "dry_run"
      ? ({ messages: { create: async () => { throw new Error("dry-run never calls a model"); } } } as unknown as Anthropic)
      : new Anthropic(),
    log: (line) => console.log(line),
    dbNowMs,
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.md"), markdownReport(sha, result));
  writeFileSync(join(outDir, "candidates.csv"), candidatesCsv(sha, result));
  writeFileSync(join(outDir, "skipped.csv"), skippedCsv(sha, result));
  if (args.mode !== "dry_run") writeFileSync(join(outDir, "items.csv"), itemsCsv(sha, result));
  console.log(`candidates ${result.selection.candidates.length}, this run ${result.dispatched.length}, skipped ${result.selection.skipped.length}, superseded ${result.selection.superseded.length}`);
  console.log(`report: ${join(outDir, "report.md")}`);
}

main().catch((e) => {
  if (e instanceof ArgError || e instanceof BackfillRefusal) {
    console.error(`refused: ${e.message}`);
    process.exit(2);
  }
  console.error(e instanceof Error ? e.message : "failed");
  process.exit(1);
});
