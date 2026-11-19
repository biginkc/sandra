import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { FAMILIES } from "./families";
import { assertEnvLooksLocal, resolveDbUrl } from "./guards";
import { BOUNDARY_FAMILIES, laneBindFailure, laneRefresh, runCommittedLanes } from "./races";
import { buildReport, renderMarkdown, type LaneResult, type Report, type ScaleSize } from "./report";
import { runFamilies, type FamilyRun } from "./runner";
import { runScale } from "./scale";

export type StressOptions = {
  mode: "full" | "smoke";
  repeats: number;
  seed: number;
  families: string[] | null;
  /** oracle comparison | rolled-back refresh + bind-failure lanes | committed race lanes | scale lane */
  lanes: Array<"oracle" | "refresh" | "races" | "scale">;
  raceReps: number;
  scaleSizes: number[];
  scaleSamples: number;
  outDir: string | null;
  /** Lane results written by race.dispatch.integration.test.ts (the lanes that drive the real dispatchRepSms). Default: <outDir>/dispatch-lanes.json. */
  dispatchLanesFile?: string | null;
  log?: (line: string) => void;
};

export const FULL_DEFAULTS: StressOptions = {
  mode: "full", repeats: 20, seed: 20261015, families: null, lanes: ["oracle", "refresh", "races", "scale"], raceReps: 200, scaleSizes: [400, 2000], scaleSamples: 10,
  outDir: path.resolve("test-results/my-leads-queue-stress"),
};

/** 1 repeat, 3 families, one rep of each lane family. Proves the harness itself still runs; says nothing about the queue. */
export const SMOKE_DEFAULTS: StressOptions = {
  mode: "smoke", repeats: 1, seed: 1, families: ["callback_boundary", "stamped_x_then_y", "drip_health"], lanes: ["oracle", "refresh"], raceReps: 0, scaleSizes: [], scaleSamples: 0, outDir: null,
};

const git = (...args: string[]) => { try { return execFileSync("git", args, { encoding: "utf8" }).trim(); } catch { return "unknown"; } };

export async function runStress(opts: StressOptions, env: Record<string, string | undefined> = process.env): Promise<Report> {
  const log = opts.log ?? (() => {});
  assertEnvLooksLocal(env);
  const url = resolveDbUrl(env);
  const u = new URL(url);
  const startedAt = new Date().toISOString();
  const selected = opts.families ? FAMILIES.filter((f) => opts.families!.includes(f.id)) : FAMILIES;
  const unknown = (opts.families ?? []).filter((id) => !FAMILIES.some((f) => f.id === id));
  if (unknown.length) throw new Error(`unknown family: ${unknown.join(", ")}`);
  let runs: FamilyRun[] = [];
  const lanes: LaneResult[] = [];
  let scale: ScaleSize[] = [];
  if (opts.lanes.includes("oracle")) {
    log(`oracle lane: ${selected.length} families x ${opts.repeats} repeats x 15 variants`);
    runs = await runFamilies(url, { families: selected, repeats: opts.repeats, seed: opts.seed, onWorld: (f, r, w) => log(`  ${f} #${r}: ${w.leads} leads, ${w.mismatches.length} mismatches`) });
  }
  if (opts.lanes.includes("refresh")) {
    log("refresh lane: next_change_at for each boundary family");
    const fams = opts.mode === "smoke" ? BOUNDARY_FAMILIES.slice(0, 3) : BOUNDARY_FAMILIES;
    lanes.push(...(await laneRefresh(url, opts.mode === "smoke" ? 1 : opts.repeats, opts.seed, fams)));
    log("bind-RPC failure lane");
    lanes.push(await laneBindFailure(url, opts.mode === "smoke" ? 1 : Math.max(20, opts.repeats * 5), opts.seed));
  }
  if (opts.lanes.includes("races")) {
    log(`race lanes: ${opts.raceReps} reps`);
    lanes.push(...(await runCommittedLanes(url, opts.raceReps, opts.seed)));
  }
  const dispatchFile = opts.dispatchLanesFile ?? (opts.outDir ? path.join(opts.outDir, "dispatch-lanes.json") : null);
  if (opts.lanes.includes("races") && dispatchFile && existsSync(dispatchFile)) {
    log(`dispatchRepSms lanes: ${dispatchFile}`);
    const file = JSON.parse(readFileSync(dispatchFile, "utf8")) as { sha?: string; reps?: number; lanes?: LaneResult[] };
    const head = git("rev-parse", "--short", "HEAD");
    const ids = new Set((file.lanes ?? []).map((l) => l.id));
    const problems: string[] = [];
    if (file.sha !== head) problems.push(`written at ${file.sha ?? "unknown"}, not ${head}`);
    if (opts.mode === "full" && (file.reps ?? 0) < opts.raceReps) problems.push(`${file.reps ?? 0} reps, fewer than --race-reps ${opts.raceReps}`);
    for (const id of ["race:dispatch_stamped_send_vs_inbound", "race:dispatch_bind_failure"]) if (!ids.has(id)) problems.push(`missing ${id}`);
    // executed reps, not the requested number: a lane that threw early has fewer runs
    for (const l of file.lanes ?? []) if (!l.skipped && l.runs < Math.min(file.reps ?? 0, l.id === "race:dispatch_bind_failure" ? 20 : Infinity)) problems.push(`${l.id} executed ${l.runs} of ${file.reps} reps`);
    if ((file.reps ?? 0) < 1) problems.push("0 reps");
    if (problems.length) lanes.push({ id: "race:dispatch_file", title: "dispatchRepSms lane results file", runs: 0, failures: 1, samples: problems });
    lanes.push(...(file.lanes ?? []));
  }
  if (opts.lanes.includes("scale")) {
    log(`scale lane: ${opts.scaleSizes.join(", ")} leads`);
    const result = await runScale(url, { sizes: opts.scaleSizes, samples: opts.scaleSamples, seed: opts.seed });
    scale = result.sizes;
    if (result.mismatches.length) runs.push({ family: "scale_counts", title: "scale lane counts and badge vs oracle", worlds: scale.length, leads: 0, checks: result.mismatches.length, mismatches: result.mismatches, errors: [], timings: {}, ms: 0, variantLeads: {}, variantFailures: {} });
  }
  const report = buildReport({ mode: opts.mode, seed: opts.seed, repeats: opts.repeats, raceReps: opts.raceReps, scaleSamples: opts.scaleSamples, sha: git("rev-parse", "--short", "HEAD"), database: `${u.hostname}:${u.port || "5432"}`, startedAt, runs, lanes, scale });
  if (opts.outDir) {
    mkdirSync(opts.outDir, { recursive: true });
    writeFileSync(path.join(opts.outDir, "report.json"), JSON.stringify(report, null, 2));
    writeFileSync(path.join(opts.outDir, "report.md"), renderMarkdown(report));
    log(`report: ${path.join(opts.outDir, "report.md")}`);
  }
  return report;
}
