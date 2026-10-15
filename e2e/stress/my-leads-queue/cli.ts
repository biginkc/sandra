import path from "node:path";

import { FAMILIES } from "./families";
import { FULL_DEFAULTS, SMOKE_DEFAULTS, runStress, type StressOptions } from "./run";

/**
 * My Leads unified queue stress harness. Runs ONLY against a loopback Postgres (see guards.ts), never reads a .env file,
 * never calls a provider. Exit code 0 only when every exit criterion passes.
 *
 *   npx tsx e2e/stress/my-leads-queue/cli.ts [--smoke] [--repeats 20] [--seed N] [--families a,b] [--lanes oracle,refresh,races,scale]
 *       [--race-reps 200] [--dispatch-lanes FILE] [--scale-sizes 400,2000] [--scale-samples 10] [--out DIR] [--list]
 */
function parse(argv: string[]): StressOptions | "list" {
  const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes("--list")) return "list";
  const base = argv.includes("--smoke") ? SMOKE_DEFAULTS : FULL_DEFAULTS;
  // Counts that size the work must be positive: a zero-work run must never be able to PASS.
  const num = (name: string, fallback: number, min = 0) => { const v = arg(name); if (v === undefined) return fallback; const n = Number(v); if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}`); return n; };
  const lanes = arg("lanes")?.split(",") as StressOptions["lanes"] | undefined;
  for (const l of lanes ?? []) if (!["oracle", "refresh", "races", "scale"].includes(l)) throw new Error(`unknown lane ${l}`);
  return {
    ...base,
    repeats: num("repeats", base.repeats, 1), seed: num("seed", base.seed), raceReps: num("race-reps", base.raceReps, 1), scaleSamples: num("scale-samples", base.scaleSamples, 1),
    scaleSizes: arg("scale-sizes")?.split(",").map(Number) ?? base.scaleSizes, families: arg("families")?.split(",") ?? base.families, lanes: lanes ?? base.lanes,
    outDir: arg("out") ? path.resolve(arg("out")!) : base.outDir, dispatchLanesFile: arg("dispatch-lanes") ? path.resolve(arg("dispatch-lanes")!) : null, log: (l) => console.log(l),
  };
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts === "list") { for (const f of FAMILIES) console.log(`${f.id}\t${f.title}`); return; }
  const report = await runStress(opts);
  console.log(`\nverdict: ${report.verdict}`);
  for (const r of report.failReasons) console.log(`  - ${r}`);
  process.exit(report.verdict === "PASS" ? 0 : 1);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(2); });
