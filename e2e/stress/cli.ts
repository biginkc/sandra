import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readConfig, type StressConfig } from "./config";
import { artifactsDirFor, runChaos } from "./engine";
import { assertStressLane, LaneRefusal } from "./guards";
import { buildManifest, toNdjson, type Profile } from "./manifest";
import { runSelfTest } from "./selftest";
import { loadReportKey, sha256, signEvidence } from "./signing";

/**
 * Entrypoint (opt-in; never part of the default CI lanes):
 *
 *   STRESS_HARNESS=1 ... npm run stress -- run          the chaos day (replay engine, then browser lane in full scope)
 *   STRESS_HARNESS=1 ... npm run stress -- selftest     three fault injections + a control; each fault must turn the run red
 *   STRESS_HARNESS=1 ... npm run stress -- plan         write schedule.ndjson only (no connections at all)
 *   STRESS_HARNESS=1 ... npm run stress -- kill         drop a KILL file next to the running run's artifacts
 *   STRESS_LIVE_LEG=1 ... npm run stress -- live-check  report which live-leg prerequisites are unmet (never dials)
 */


export function loadConfig(): StressConfig {
  return readConfig(process.env);
}

async function main(): Promise<number> {
  const cmd = process.argv[2] ?? "run";
  const profile = (process.env.STRESS_PROFILE ?? "full") as Profile;
  if (profile !== "full" && profile !== "short") throw new Error("STRESS_PROFILE must be full or short");

  if (cmd === "plan") {
    // No connection of any kind: pure function of the seed.
    const cfg = loadConfig();
    const dir = artifactsDirFor(cfg, profile);
    mkdirSync(dir, { recursive: true });
    const m = buildManifest(cfg.seed, cfg.runTag, { profile });
    writeFileSync(path.join(dir, "schedule.ndjson"), toNdjson(m));
    console.log(`schedule written: ${m.ticks.length} ticks (${m.total} calls), hash ${m.hash}\n${dir}/schedule.ndjson`);
    return 0;
  }
  if (cmd === "kill") {
    const cfg = loadConfig();
    const dir = artifactsDirFor(cfg, profile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "KILL"), new Date().toISOString());
    console.log(`KILL file written: ${dir}/KILL (the running harness kills within one invariant interval)`);
    return 0;
  }
  if (cmd === "pin-number") {
    // Prints ONLY the sha256 of the owned number behind an op ref, for the operator to commit in owned-numbers.sha256.json. Never prints the number.
    const role = process.argv[3];
    if (role !== "cell" && role !== "telnyx") throw new Error("usage: stress pin-number <cell|telnyx>");
    const { createHash } = await import("node:crypto");
    const { execFileSync } = await import("node:child_process");
    const ref = process.env[role === "cell" ? "STRESS_OP_REF_CELL" : "STRESS_OP_REF_TELNYX"] ?? "";
    if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) throw new Error("OP_SERVICE_ACCOUNT_TOKEN is not set: refusing to run `op read`");
    if (!/^op:\/\/[^\s]+$/.test(ref)) throw new Error("the op ref env is not an op:// reference");
    const v = execFileSync("op", ["read", "--no-newline", ref], { encoding: "utf8", timeout: 20_000 }).trim();
    if (!/^\+1\d{10}$/.test(v)) throw new Error("the value is not a +1XXXXXXXXXX number");
    console.log(createHash("sha256").update(v).digest("hex"));
    return 0;
  }
  if (cmd === "live-check") {
    const { liveLegStatus } = await import("./live-leg");
    const cfg = loadConfig();
    const s = await liveLegStatus(cfg, process.env);
    console.log(JSON.stringify(s, null, 2));
    return s.ready ? 0 : 2;
  }
  if (cmd === "selftest") {
    const cfg = loadConfig();
    assertStressLane(cfg, process.env);
    const r = await runSelfTest(cfg);
    console.log(JSON.stringify(r.rows, null, 2));
    // Recorded for the live leg: a passing self-test at THIS sha is a prerequisite (STRESS_SELFTEST_REPORT points at it).
    const out = path.resolve(cfg.artifactsRoot, `selftest-${cfg.sha.slice(0, 12)}.json`);
    mkdirSync(path.dirname(out), { recursive: true });
    let sig: unknown = null;
    try {
      const key = loadReportKey(process.env);
      if (key) sig = signEvidence({ v: 1, kind: "selftest", runId: cfg.runId, sha: cfg.sha, at: new Date().toISOString(), subjectSha256: sha256(JSON.stringify({ sha: cfg.sha, ok: r.ok, rows: r.rows })) }, key);
    } catch (e) { console.error(`self-test report not signed: ${(e as Error).message}`); }
    writeFileSync(out, JSON.stringify({ sha: cfg.sha, ok: r.ok, at: new Date().toISOString(), rows: r.rows, sig }, null, 2));
    console.log(`self-test report: ${out}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === "run") {
    const cfg = loadConfig();
    const r = await runChaos({ cfg, profile, resetFirst: process.env.STRESS_RESET_FIRST === "1" });
    return r.exitCode;
  }
  console.error(`unknown command ${cmd}`);
  return 64;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof LaneRefusal) console.error(`REFUSED ${e.code}: ${e.message}`);
    else console.error(e);
    process.exit(e instanceof LaneRefusal ? 78 : 1);
  },
);
