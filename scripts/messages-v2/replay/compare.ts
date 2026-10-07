#!/usr/bin/env tsx
/**
 * npm run replay:compare -- --batch <id> [--concurrency 4] [--limit N] [--head-to-head]
 *                           [--scope below_threshold|all_holds] [--eligibility policy|any]
 *
 * Jev -> Luna fallback cascade evaluation on a masked replay export (tmp/replay/<batch>.json).
 * Needs: TYPESAFE_API_KEY, OPENAI_API_KEY (not for LUNA_API=codex-cli, which uses the local Codex CLI login), LUNA_MODEL (no default). Optional: LUNA_API=responses|chat,
 * LUNA_TIMEOUT_MS, LUNA_PRICE_INPUT_PER_MTOK + LUNA_PRICE_OUTPUT_PER_MTOK (USD per 1M tokens, for cost).
 * Standalone: no database, no replay server, no SMS. Resumable cache: tmp/replay/compare-<batch>.jsonl.
 * Writes tmp/replay/compare-<batch>.report.{md,json} (mode 600; contains masked message text).
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { REPLAY_DIR, assertBatchId, exportPathFor, fail, loadExport } from "./cli";
import { FileCache } from "./compare-cache";
import { buildReport, jevDeps, renderMarkdown, runCompare, type CompareDeps, type CompareOptions } from "./compare-core";
import { assertCompareSafety } from "./compare-safety";
import { classifyWithLuna, lunaConfigFromEnv, LunaConfigError } from "./classifiers/luna";
import { readProdRefs } from "./safety";

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: "string" }, batch: { type: "string" }, out: { type: "string" },
      concurrency: { type: "string", default: "4" }, limit: { type: "string" },
      "head-to-head": { type: "boolean", default: false },
      scope: { type: "string", default: "below_threshold" },
      eligibility: { type: "string", default: "policy" },
      "allow-project-ref": { type: "string" },
      "count-only": { type: "boolean", default: false },
    },
  });
  const file = values.file ?? (values.batch ? exportPathFor(assertBatchId(values.batch)) : null);
  if (!file) fail("--file <export.json> or --batch <id> is required");
  if (values.scope !== "below_threshold" && values.scope !== "all_holds") fail("--scope must be below_threshold or all_holds");
  if (values.eligibility !== "policy" && values.eligibility !== "any") fail("--eligibility must be policy or any");
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) fail("--concurrency must be 1..16");

  try {
    assertCompareSafety(process.env, readProdRefs(process.cwd()), values["allow-project-ref"] ?? null);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const jevKey = (process.env.TYPESAFE_API_KEY ?? "").trim();
  if (!jevKey) fail("TYPESAFE_API_KEY is required (Jev)");
  let luna;
  try {
    luna = lunaConfigFromEnv(process.env);
  } catch (error) {
    if (error instanceof LunaConfigError) fail(error.message);
    throw error;
  }
  if (luna.api === "codex-cli" && concurrency > 4) fail("--concurrency must be at most 4 with LUNA_API=codex-cli");
  const inP = process.env.LUNA_PRICE_INPUT_PER_MTOK, outP = process.env.LUNA_PRICE_OUTPUT_PER_MTOK;
  const prices = inP && outP && Number.isFinite(Number(inP)) && Number.isFinite(Number(outP)) ? { inputPerMTok: Number(inP), outputPerMTok: Number(outP) } : null;

  const exp = loadExport(file);
  const cache = new FileCache(path.join(REPLAY_DIR, `compare-${exp.batchId}.jsonl`));
  const deps: CompareDeps = {
    jev: jevDeps(jevKey, fetch),
    luna: values["count-only"] ? null : (thread) => classifyWithLuna(luna, thread, { fetch }),
    cache, lunaModel: luna.model, lunaApi: luna.api,
    log: (l) => console.log(l),
  };
  const opts: CompareOptions = {
    concurrency, limit: values.limit ? Number(values.limit) : null, headToHead: values["head-to-head"],
    scope: values.scope, eligibility: values.eligibility, lunaPrices: prices,
  };
  console.log(`replay:compare batch ${exp.batchId}: ${exp.inbound.length} inbound, luna model ${luna.model} (${luna.api}), concurrency ${concurrency}`);
  const run = await runCompare(exp, opts, deps);
  if (values["count-only"]) {
    const holds = run.rows.filter((r) => r.jevDecision.status === "hold" && (opts.scope === "all_holds" || r.jevDecision.reason === "needs_decision"));
    console.log(`replay:compare count-only: ${holds.length} of ${run.rows.length} messages would go to Luna (scope ${opts.scope}); no Luna calls made, no report written`);
    return;
  }
  const report = buildReport(exp, run, opts, { generatedAt: new Date().toISOString(), lunaModel: luna.model });
  const base = values.out ? path.resolve(values.out) : path.join(REPLAY_DIR, `compare-${exp.batchId}.report`);
  mkdirSync(path.dirname(base), { recursive: true });
  for (const [ext, body] of [["json", JSON.stringify(report, null, 2)], ["md", renderMarkdown(report)]] as const) {
    writeFileSync(`${base}.${ext}`, body, { mode: 0o600 });
    chmodSync(`${base}.${ext}`, 0o600);
    console.log(`replay:compare wrote ${base}.${ext}`);
  }
  const c = report.explicit.cascade.find((x) => x.cutoff === 0.9);
  console.log(`replay:compare done. jev calls ${run.stats.jevCalls} (cached ${run.stats.jevCached}), luna calls ${run.stats.lunaCalls} (cached ${run.stats.lunaCached})` + (c ? `; at Luna>=0.90: resolved ${c.resolved}/${c.scopeHolds}, wrong ${c.wrong}` : ""));
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
