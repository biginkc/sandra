import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { appProofProblems, envFilesIn, type AppProofInput } from "./app-proof";
import { readConfig, type StressConfig } from "./config";
import { egressChildEnv } from "./egress";
import { scanServerLog } from "./engine";
import { GateController } from "./gates";
import { assertLiveLane, assertOnlyHarnessData, assertStressLane, DEV_STACK_PORTS, LaneRefusal } from "./guards";
import { driveLiveLeg, SECOND_DIAL_WINDOW_MS, summarizeLive, type LivePort } from "./live-driver";
import { liveAppRecheckProblems, liveCallPlan, type LiveEvidence } from "./live-leg";
import { buildManifest, MANDATORY } from "./manifest";
import { KPI_REQUIRED_KEYS, kpiTotalProblems, type Check } from "./oracle";
import { nonVacuityProblems } from "./parity";
import { decide, type Verdict } from "./report";
import { newRecord } from "./scenarios";
import { evidenceProblems, loadReportKey, sha256, signEvidence } from "./signing";

const SHA = "a".repeat(40);
const ROOT = path.join(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");

// ------------------------------------------------------------------ decide()
const mkCheck = (id: number, over: Partial<Check> = {}): Check => ({ id, name: `check ${id}`, tier: id <= 10 ? "invariant" : "outcome", ok: true, violations: [], ...over });
const allChecks = (over: Record<number, Partial<Check>> = {}) => Array.from({ length: 16 }, (_, i) => mkCheck(i + 1, over[i + 1]));
function fullInput(env: Record<string, string> = {}, over: Partial<Parameters<typeof decide>[0]> = {}): Parameters<typeof decide>[0] {
  const cfg = readConfig(env, { headSha: () => SHA });
  const manifest = buildManifest(cfg.seed, cfg.runTag, { profile: (env.PROFILE as "full" | "short") ?? "full" });
  const checks = allChecks();
  return {
    cfg, manifest, records: manifest.ticks.filter((t) => t.actor === "replay").map((t) => newRecord(t, null)),
    invariantChecks: checks.slice(0, 10), outcomeChecks: checks.slice(10), egressViolations: 0, serverProblems: [], killed: null, setupErrors: [],
    browserExecuted: manifest.ticks.filter((t) => t.actor === "browser").length, ...over,
  };
}
const verdict = (i: Parameters<typeof decide>[0]): Verdict => decide(i).verdict;

describe("sweep 1: decide() fails unless every mandatory piece RAN (and every branch is pinned)", () => {
  it("a complete, clean, full-scope run is a PASS, reachable without any pf proof", () => {
    expect(verdict(fullInput())).toBe("PASS");
  });
  it("empty checks, records and counts are a FAIL (the old behaviour returned PASS on empty arrays)", () => {
    const r = decide(fullInput({}, { records: [], invariantChecks: [], outcomeChecks: [] }));
    expect(r.verdict).toBe("FAIL");
    expect(r.reasons.join("\n")).toMatch(/no invariant checks ran/);
    expect(r.reasons.join("\n")).toMatch(/no outcome checks ran/);
    expect(r.reasons.join("\n")).toMatch(/no tick records/);
    expect(r.reasons.join("\n")).toMatch(/mandatory check 7 did not run/);
  });
  it("one missing mandatory check, or a truncated replay lane, is a FAIL", () => {
    const i = fullInput();
    expect(decide({ ...i, invariantChecks: i.invariantChecks.filter((c) => c.id !== 7) }).reasons.join()).toMatch(/mandatory check 7 did not run/);
    const short = decide({ ...i, records: i.records.slice(1) });
    expect(short.verdict).toBe("FAIL");
    expect(short.reasons.join()).toMatch(/executed \d+\/\d+ replay ticks/);
    expect(MANDATORY.length).toBeGreaterThan(0);
  });
  it("a red check, a deferred check in a full-scope run, an egress violation, a browser shortfall, server problems, a kill and an errored tick are each a FAIL", () => {
    expect(verdict(fullInput({}, { invariantChecks: allChecks({ 3: { ok: false, violations: [{}] } }).slice(0, 10) }))).toBe("FAIL");
    expect(verdict(fullInput({}, { outcomeChecks: allChecks({ 16: { deferred: "needs the browser lane" } }).slice(10) }))).toBe("FAIL");
    expect(verdict(fullInput({}, { egressViolations: 1 }))).toBe("FAIL");
    expect(verdict(fullInput({}, { browserExecuted: 3 }))).toBe("FAIL");
    expect(verdict(fullInput({}, { serverProblems: ["server log: x 500 in 5ms"] }))).toBe("FAIL");
    expect(verdict(fullInput({}, { setupErrors: ["boom"] }))).toBe("FAIL");
    const i = fullInput();
    expect(verdict({ ...i, records: [{ ...i.records[0]!, error: "boom" }, ...i.records.slice(1)] })).toBe("FAIL");
    expect(verdict(fullInput({}, { killed: { reason: "x", steps: [], cannotRecall: { smsAccepted: 0, contractsSent: 0, callsDialled: 0 } } as never }))).toBe("FAIL");
  });
  it("PARTIAL_PASS: a reduced scope, a short profile, the reminder window closed, or a fault injection never reaches PASS", () => {
    expect(verdict(fullInput({ STRESS_SCOPE: "replay" }, { outcomeChecks: allChecks({ 16: { deferred: "browser lane" } }).slice(10) }))).toBe("PARTIAL_PASS");
    expect(verdict(fullInput({ PROFILE: "short" }))).toBe("PARTIAL_PASS");
    expect(verdict(fullInput({}, { reminderWindowOpen: false }))).toBe("PARTIAL_PASS");
    expect(verdict(fullInput({ STRESS_FAULT: "drop_offer" }))).toBe("PARTIAL_PASS");
  });
  it("nothing in the harness reads pf state as proof (no pfctl, no pf verdict input, no OS-ring claim)", () => {
    const files = readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const f of files) expect(read(f), f).not.toMatch(/pfctl|proveOsDenial|osEgressProven|STRESS_REQUIRE_OS_EGRESS/);
    expect(read("report.ts")).toMatch(/OS egress ring: not claimed/);
    expect(read("live-leg.ts")).not.toMatch(/os_egress/);
  });
});

// -------------------------------------------------------------- scan / oracle
describe("sweep 3: scanServerLog slices by BYTES", () => {
  it("multibyte text before the offset does not hide later errors", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "scan-"));
    const f = path.join(dir, "app.log");
    const prefix = "ééééééééééé\n"; // 11 two-byte characters + newline: 23 bytes, 12 characters
    writeFileSync(f, `${prefix} GET /a 500 in 12ms\n GET /b 502 in 9ms\n`);
    const out = scanServerLog(f, Buffer.byteLength(prefix));
    expect(out).toHaveLength(2); // a character slice at byte offset 23 would have cut into the first error line
  });
});
describe("sweep 8: KPI parity asserts every required key", () => {
  const rules = { attempts: "EQ", reached: "EQ", offersSent: "EQ" };
  it("passes only when attempts, reached and offersSent are all classified EQUAL, present and equal", () => {
    expect(KPI_REQUIRED_KEYS).toEqual(["attempts", "reached", "offersSent"]);
    expect(kpiTotalProblems({ attempts: 3, reached: 2, offersSent: 1 }, { attempts: 3, reached: 2, offersSent: 1 }, rules, "EQ")).toEqual([]);
  });
  it("a key reclassified, missing from the KPI, or without an expected total is a violation (the old loop skipped it silently)", () => {
    expect(kpiTotalProblems({ attempts: 3, reached: 2, offersSent: 1 }, { attempts: 3, reached: 2, offersSent: 1 }, { ...rules, reached: "OTHER" }, "EQ").map((v) => v.rule)).toContain("kpi_key_not_asserted");
    expect(kpiTotalProblems({ attempts: 3, reached: 2 }, { attempts: 3, reached: 2, offersSent: 1 }, rules, "EQ").map((v) => v.rule)).toContain("kpi_key_missing");
    expect(kpiTotalProblems({ attempts: 3, reached: 2, offersSent: 1 }, { attempts: 3, reached: 2 }, rules, "EQ").map((v) => v.rule)).toContain("kpi_expected_total_missing");
    expect(kpiTotalProblems({ attempts: 4, reached: 2, offersSent: 1 }, { attempts: 3, reached: 2, offersSent: 1 }, rules, "EQ").map((v) => v.rule)).toContain("kpi_total");
  });
});
describe("sweep 4/5: parity is not vacuous", () => {
  const rows = [{ property_id: "a", stage: "contacted", in_drip: false, is_run_lead: true }, { property_id: "b", stage: "contacted", in_drip: false, is_run_lead: true }];
  it("an empty strip, an empty queue, or a run lead missing from the queue is refused", () => {
    expect(nonVacuityProblems({ renderedStrip: ["a"], dbStrip: ["a"], queueRows: rows, runLeadIds: ["a", "b"] })).toEqual([]);
    expect(nonVacuityProblems({ renderedStrip: [], dbStrip: ["a"], queueRows: rows, runLeadIds: ["a", "b"] }).join()).toMatch(/rendered no strip rows/);
    expect(nonVacuityProblems({ renderedStrip: ["a"], dbStrip: [], queueRows: rows, runLeadIds: ["a", "b"] }).join()).toMatch(/no Call-next rows/);
    expect(nonVacuityProblems({ renderedStrip: ["a"], dbStrip: ["a"], queueRows: [], runLeadIds: [] }).join()).toMatch(/queue is empty/);
    expect(nonVacuityProblems({ renderedStrip: ["a"], dbStrip: ["a"], queueRows: rows, runLeadIds: ["a", "b", "c"] }).join()).toMatch(/1 run lead\(s\) are missing/);
  });
});
describe("sweep 13: armed gates that never fired are reported", () => {
  it("an armed gate with no hits is unfired; one that caught a request is not", async () => {
    const g = new GateController();
    const idle = g.arm("provider_accepted", { source: "dropbox_sign" });
    const hit = g.arm("response_sent", { source: "dialpad" });
    const parked = g.reach("r1", "response_sent", { source: "dialpad", path: "/x" });
    await g.waitReached(hit, 1000);
    g.release(hit);
    await parked;
    expect(g.unfiredGates().map((x) => x.id)).toEqual([idle]);
    expect(read("engine.ts")).toMatch(/unfiredGates\(\)/);
  });
});
describe("sweep 2: stale artifacts are deleted at engine start and the report is run-bound", () => {
  it("REPORT.md, its signature and the other per-run files are removed at start; the report carries its run id", () => {
    const eng = read("engine.ts");
    for (const f of ["REPORT.md", "REPORT.sig.json", "invariants.final.json", "config.json", "world.json", "schedule.ndjson", "app-proof.json"]) expect(eng, f).toContain(`"${f}"`);
    expect(read("report.ts")).toMatch(/- Run: \$\{cfg\.runId\}/);
  });
});

// ------------------------------------------------------------ signing (live B)
describe("live B: evidence signing keys live outside the repo, mode 0600, and verify run-bound evidence", () => {
  const good = "k".repeat(40);
  it("loadReportKey refuses a key file inside the repo, group/other-readable, relative, missing or short; accepts a 0600 file outside", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "key-"));
    const f = path.join(dir, "key");
    writeFileSync(f, good); chmodSync(f, 0o600);
    expect(loadReportKey({ STRESS_REPORT_KEY_FILE: f })).toBe(good);
    chmodSync(f, 0o644);
    expect(() => loadReportKey({ STRESS_REPORT_KEY_FILE: f })).toThrow(/0600/);
    expect(() => loadReportKey({ STRESS_REPORT_KEY_FILE: path.join(ROOT, "key") }, { mode: () => 0o600, readFile: () => good })).toThrow(/outside the repository/);
    expect(() => loadReportKey({ STRESS_REPORT_KEY_FILE: "rel/key" })).toThrow(/absolute/);
    expect(() => loadReportKey({ STRESS_REPORT_KEY_FILE: path.join(dir, "nope") })).toThrow(/does not exist/);
    chmodSync(f, 0o600); writeFileSync(f, "short"); chmodSync(f, 0o600);
    expect(() => loadReportKey({ STRESS_REPORT_KEY_FILE: f })).toThrow(/shorter/);
    expect(loadReportKey({})).toBeNull();
  });
  it("op key: refused without the service account token; an injected reader works", () => {
    expect(() => loadReportKey({ STRESS_REPORT_KEY_OP_REF: "op://v/i/k" })).toThrow(/OP_SERVICE_ACCOUNT_TOKEN/);
    expect(loadReportKey({ STRESS_REPORT_KEY_OP_REF: "op://v/i/k" }, { opRead: () => good })).toBe(good);
  });
  it("evidenceProblems: unsigned, wrong key, tampered content, wrong run, stale, future and unknown sha are refused", () => {
    const text = "report";
    const now = Date.parse("2026-10-06T12:00:00Z");
    const doc = signEvidence({ v: 1, kind: "stub_leg", runId: "r1", sha: SHA, at: new Date(now - 1000).toISOString(), subjectSha256: sha256(text), verdict: "PASS", profile: "full", scope: "full", fault: "none", appGuardPid: 99 }, good);
    const want = { kind: "stub_leg" as const, sha: SHA, subjectText: text, runId: "r1", now };
    expect(evidenceProblems(doc, good, want)).toEqual([]);
    expect(evidenceProblems(null, good, want).join()).toMatch(/unsigned/);
    expect(evidenceProblems(doc, "z".repeat(40), want).join()).toMatch(/does not verify/);
    expect(evidenceProblems(doc, good, { ...want, subjectText: "edited" }).join()).toMatch(/does not match what was signed/);
    expect(evidenceProblems(doc, good, { ...want, runId: "r2" }).join()).toMatch(/not r2/);
    expect(evidenceProblems(doc, good, { ...want, now: now + 25 * 3600_000 }).join()).toMatch(/older than/);
    expect(evidenceProblems(doc, good, { ...want, now: now - 3600_000 }).join()).toMatch(/future/);
    expect(evidenceProblems(doc, good, { ...want, sha: "unknown" }).join()).toMatch(/sha is unknown/);
    expect(evidenceProblems(doc, good, { ...want, kind: "selftest" }).join()).toMatch(/not a selftest/);
    for (const [k, v] of Object.entries({ verdict: "FAIL", profile: "short", scope: "replay", fault: "drop_offer", appGuardPid: null })) {
      const d = signEvidence({ v: 1, kind: "stub_leg", runId: "r1", sha: SHA, at: new Date(now - 1000).toISOString(), subjectSha256: sha256(text), verdict: "PASS", profile: "full", scope: "full", fault: "none", appGuardPid: 99, [k]: v } as never, good);
      expect(evidenceProblems(d, good, want).length, k).toBeGreaterThan(0); // the signed verdict and run shape are enforced by the signature check itself
    }
  });
});

// ------------------------------------------------ live leg D, F, G + lane + configs
describe("live D: the app identity is re-checked before every dial, and the live lane is guarded", () => {
  const LOG = "/tmp/live-id.jsonl";
  const facts = (over: Record<string, unknown> = {}) => ({ pid: 7, uid: 501, startMs: Date.parse("2026-10-06T12:00:00Z"), envFiles: [] as string[], lines: [JSON.stringify({ kind: "guard_loaded", pid: 7, at: "2026-10-06T12:00:05Z", log: LOG, sha: SHA, dirty: false, redirect: null })], ...over }) as Parameters<typeof liveAppRecheckProblems>[0];
  it("pid, sha, tree, uid, a guard line that postdates the process, and .env files are all checked", () => {
    expect(liveAppRecheckProblems(facts(), SHA, LOG, 501)).toEqual([]);
    expect(liveAppRecheckProblems(facts({ pid: null }), SHA, LOG, 501).join()).toMatch(/no process/);
    expect(liveAppRecheckProblems(facts({ uid: 502 }), SHA, LOG, 501).join()).toMatch(/uid 502/);
    expect(liveAppRecheckProblems(facts({ startMs: Date.parse("2026-10-06T13:00:00Z") }), SHA, LOG, 501).join()).toMatch(/postdate/);
    expect(liveAppRecheckProblems(facts({ envFiles: [".env.local"] }), SHA, LOG, 501).join()).toMatch(/\.env\.local/);
    expect(liveAppRecheckProblems(facts(), "b".repeat(40), LOG, 501).join()).toMatch(/runs commit/);
  });
  const env = { STRESS_LIVE_LEG: "1", E2E_DISPOSABLE_DATABASE: "1", E2E_CI_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55430/postgres", STRESS_SUPABASE_URL: "http://127.0.0.1:55431", TEST_SUPABASE_URL: "http://127.0.0.1:55431", STRESS_APP_URL: "http://127.0.0.1:3466", E2E_CRON_SECRET: "x".repeat(20), DIALPAD_CTI_WEBHOOK_SECRET_E2E: "y".repeat(20), STRESS_TUNNEL_URL: "https://t.example.net" };
  it("assertLiveLane needs STRESS_LIVE_LEG=1, refuses CI, and requires BOTH Supabase URLs to be loopback; the stub lane still refuses the live flag", () => {
    const cfg = readConfig(env, { headSha: () => SHA });
    expect(() => assertLiveLane(cfg, { ...env, STRESS_HARNESS: "1" })).not.toThrow();
    expect(() => assertLiveLane(cfg, { ...env, STRESS_HARNESS: "1", STRESS_LIVE_LEG: undefined })).toThrow(LaneRefusal);
    expect(() => assertLiveLane(cfg, { ...env, STRESS_HARNESS: "1", CI: "1" })).toThrow(/CI/);
    expect(() => assertLiveLane(cfg, { ...env, STRESS_HARNESS: "1", TEST_SUPABASE_URL: "https://x.supabase.co" })).toThrow(LaneRefusal);
    expect(() => assertLiveLane(cfg, { ...env, STRESS_HARNESS: "1", TEST_SUPABASE_URL: undefined })).toThrow(/TEST_SUPABASE_URL/);
    expect(() => assertStressLane(cfg, { ...env, STRESS_HARNESS: "1" })).toThrow(/LIVE_LEG_IN_STUB_RUN/);
  });
});
describe("live F + G: cancel is reported not driven; the second dial is timed from the click and a late intent is a double dial", () => {
  const GOOD: LiveEvidence = { callId: "9001", terminalState: "hangup", cause: "missed", attemptMatched: true };
  function port(over: { refuse8?: boolean; lateIntent?: boolean; click7?: number; click8?: number; recheck?: () => Promise<void> } = {}): LivePort & { dials: number[] } {
    const dials: number[] = [];
    return {
      dials,
      async dial(step) { dials.push(step.n); return { refused: step.n === 8 ? over.refuse8 !== false : false, clickedAtMs: step.n === 7 ? over.click7 ?? 1000 : step.n === 8 ? over.click8 ?? 6000 : 0 }; },
      async awaitTerminal() { return true; },
      async evidence() { return GOOD; },
      async lateDial(step) { return step.n === 8 && over.lateIntent === true; },
      recheck: over.recheck ?? (async () => {}),
      async sleep() {},
      killRequested: () => false,
      log: () => {},
    };
  }
  it("F: a fully successful run is ok with cancel_before_answer excluded from the required count and reported explicitly", async () => {
    const plan = liveCallPlan();
    const res = await driveLiveLeg(plan, port());
    const s = summarizeLive(res, plan);
    expect(s.ok).toBe(true);
    expect(s.required).toBe(6);
    expect(s.verified).toBe(6);
    expect(s.notDriven).toBe(2);
    expect(s.notDrivenReported.join()).toMatch(/cancel_before_answer/);
  });
  it("F: any other not-driven step, a missing step or an unverified one makes the run not ok", async () => {
    const plan = liveCallPlan();
    const res = await driveLiveLeg(plan, port());
    expect(summarizeLive(res.map((r) => (r.n === 3 ? { ...r, verdict: "not_driven" as const } : r)), plan).ok).toBe(false);
    expect(summarizeLive(res.slice(0, 5), plan).ok).toBe(false);
    expect(summarizeLive(res.map((r) => (r.n === 1 ? { ...r, verdict: "unverified" as const } : r)), plan).ok).toBe(false);
  });
  it("G: a second dial that was refused in time passes; a LATE intent for the second click is a double-dial VIOLATION", async () => {
    const plan = liveCallPlan();
    const ok = await driveLiveLeg(plan, port());
    expect(ok.find((r) => r.n === 8)!.verdict).toBe("verified");
    const late = await driveLiveLeg(plan, port({ lateIntent: true }));
    const r8 = late.find((r) => r.n === 8)!;
    expect(r8.verdict).toBe("violation");
    expect(r8.detail).toMatch(/DOUBLE DIAL/);
    expect(summarizeLive(late, plan)).toMatchObject({ ok: false, violations: 1 });
  });
  it("G: the window is measured click to click: a second click more than 20 s after the first proves nothing", async () => {
    const plan = liveCallPlan();
    const res = await driveLiveLeg(plan, port({ click7: 1000, click8: 1000 + SECOND_DIAL_WINDOW_MS + 1 }));
    expect(res.find((r) => r.n === 8)!.verdict).toBe("unverified");
  });
  it("D: the identity recheck runs before EVERY dial and a failing recheck stops the run before the dial", async () => {
    let checks = 0;
    const p = port({ recheck: async () => { checks += 1; } });
    await driveLiveLeg(liveCallPlan(), p);
    expect(checks).toBe(p.dials.length); // one recheck per dial attempt (cancel steps are not dialled)
    const bad = port({ recheck: async () => { throw new Error("identity check failed"); } });
    await expect(driveLiveLeg(liveCallPlan(), bad)).rejects.toThrow(/identity check failed/);
    expect(bad.dials).toEqual([]);
  });
});
describe("live C + H: configs, CI and the stress lane", () => {
  it("C: every playwright config whose testDir is ./e2e and that matches all specs excludes **/stress/**", () => {
    for (const f of readdirSync(ROOT).filter((x) => /^playwright.*\.config\.ts$/.test(x) && x !== "playwright.stress.config.ts")) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      if (/testDir:\s*"\.\/e2e"/.test(src) && !/testMatch:/.test(src)) expect(src, f).toMatch(/\*\*\/stress\/\*\*/);
    }
    expect(readFileSync(path.join(ROOT, "playwright.prod.config.ts"), "utf8")).toMatch(/"\*\*\/stress\/\*\*"/);
  });
  it("C: the stress config does not even discover the live-leg spec unless STRESS_LIVE_LEG=1 and not CI/hosted", () => {
    const cfg = readFileSync(path.join(ROOT, "playwright.stress.config.ts"), "utf8");
    expect(cfg).toMatch(/testIgnore:[\s\S]*STRESS_LIVE_LEG === "1"[\s\S]*GITHUB_ACTIONS[\s\S]*live-leg\.spec\.ts/);
  });
  it("H: the verify workflow runs the stress unit tests, and the Playwright-spawning cases are skipped in CI", () => {
    expect(readFileSync(path.join(ROOT, ".github/workflows/verify.yml"), "utf8")).toMatch(/npm run test:stress-unit/);
    expect(read("proof-guard.test.ts")).toMatch(/describe\.skipIf\(!!process\.env\.CI\)/);
  });
});

// ------------------------------------------------------ provider reachability
describe("reach 1: dev-stack ports and foreign data are refused before anything is wiped", () => {
  const cfgFor = (dbPort: number, apiPort: number): StressConfig => readConfig({ E2E_CI_SUPABASE_DB_URL: `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`, STRESS_SUPABASE_URL: `http://127.0.0.1:${apiPort}`, STRESS_APP_URL: "http://127.0.0.1:3456", E2E_CRON_SECRET: "x".repeat(20), DIALPAD_CTI_WEBHOOK_SECRET_E2E: "y".repeat(20) }, { headSha: () => SHA });
  const env = (cfg: StressConfig) => ({ STRESS_HARNESS: "1", E2E_DISPOSABLE_DATABASE: "1", E2E_CI_SUPABASE_DB_URL: cfg.dbUrl, STRESS_SUPABASE_URL: cfg.supabaseUrl });
  it("a database or API URL on a dev-stack port is refused; fresh ports pass the port rule", () => {
    for (const port of DEV_STACK_PORTS) {
      expect(() => assertStressLane(cfgFor(port, 55431), env(cfgFor(port, 55431)))).toThrow(/DEV_STACK_PORT/);
      expect(() => assertStressLane(cfgFor(55430, port), env(cfgFor(55430, port)))).toThrow(/DEV_STACK_PORT/);
    }
    expect(() => assertStressLane(cfgFor(55430, 55431), env(cfgFor(55430, 55431)))).not.toThrow();
    expect(read("provision-stack.mjs")).toContain(`[${DEV_STACK_PORTS.join(", ")}]`); // the two lists must agree
  });
  it("a database holding non-harness leads is refused BEFORE the reset (the engine checks first)", () => {
    expect(() => assertOnlyHarnessData({ properties: 10, nonHarnessProperties: 1 })).toThrow(/DB_HAS_FOREIGN_DATA/);
    expect(() => assertOnlyHarnessData({ properties: 10, nonHarnessProperties: 0 })).not.toThrow();
    const eng = read("engine.ts");
    expect(eng.indexOf("assertOnlyHarnessRows(db)")).toBeGreaterThan(-1);
    expect(eng.indexOf("assertOnlyHarnessRows(db)")).toBeLessThan(eng.indexOf("resetTenantData(db);"));
  });
  it("reach 2: provision-stack refuses the repo root, a dir holding the repo's supabase/config.toml, and --stop on a dir it did not create", () => {
    const src = read("provision-stack.mjs");
    expect(src).toMatch(/absWork === repoRoot/);
    expect(src).toMatch(/supabase", "config\.toml"/);
    expect(src).toMatch(/\.sandra-stress-stack/);
    const root = spawnSync(process.execPath, [path.join(__dirname, "provision-stack.mjs"), "--workdir", ROOT, "--api-port", "55441", "--db-port", "55440"], { encoding: "utf8", cwd: ROOT });
    expect(root.status).not.toBe(0);
    expect(root.stderr).toMatch(/refusing --workdir/);
    const dir = mkdtempSync(path.join(os.tmpdir(), "notmine-"));
    mkdirSync(path.join(dir, "supabase"), { recursive: true });
    const stop = spawnSync(process.execPath, [path.join(__dirname, "provision-stack.mjs"), "--workdir", dir, "--stop"], { encoding: "utf8", cwd: ROOT });
    expect(stop.status).not.toBe(0);
    expect(stop.stderr).toMatch(/refusing --stop/);
  });
});

describe("reach 3 + 5: the app env proof rejects provider credentials, proxies, another stack and any .env* file", () => {
  const STUB = "http://127.0.0.1:55500";
  const LOG = "/tmp/app-egress.jsonl";
  const line = (over: Record<string, unknown> = {}, envOver: Record<string, unknown> = {}) => JSON.stringify({
    kind: "guard_loaded", pid: 4242, at: "2026-10-06T12:00:05.000Z", log: LOG, sha: SHA, dirty: false, redirect: STUB, spawnGuard: true, forbiddenPresent: [], unexpectedEnv: [],
    env: { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55431", DATABASE_URL: null, DIALPAD_DIAL_PROVIDER: null, MESSAGING_PROVIDER: "mock", DROPBOX_SIGN_API_BASE_URL: `${STUB}/dropbox-sign/v3`, VERCEL_ENV: null, VERCEL: null, ...envOver }, ...over,
  });
  const input = (l: string, over: Partial<AppProofInput> = {}): AppProofInput => ({ listenerPid: 4242, listenerUid: 501, harnessUid: 501, appEgressLog: LOG, logLines: [l], stubUrl: STUB, harnessSha: SHA, envFiles: [], listenerStartMs: Date.parse("2026-10-06T12:00:00Z"), supabaseUrl: "http://127.0.0.1:55431", dbUrl: "postgresql://postgres:postgres@127.0.0.1:55430/postgres", ...over });
  it("the clean snapshot has no problems", () => {
    expect(appProofProblems(input(line()))).toEqual([]);
  });
  it("reach 3: any provider credential or proxy override present in the app environment is refused, naming it", () => {
    for (const name of ["SENDILLO_API_KEY", "REP_SMS_FROM_NUMBER", "TWILIO_AUTH_TOKEN", "TELNYX_API_KEY", "SLACK_BOT_TOKEN", "RESEND_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HTTP_PROXY", "https_proxy", "ALL_PROXY", "no_proxy"]) {
      expect(appProofProblems(input(line({ forbiddenPresent: [name] }))).join(), name).toMatch(new RegExp(name));
    }
    expect(appProofProblems(input(line({ forbiddenPresent: undefined }))).join()).toMatch(/does not report which provider credentials/);
  });
  it("reach 3: the app must be on the harness's loopback Supabase stack and database", () => {
    expect(appProofProblems(input(line({}, { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }))).join()).toMatch(/not the harness's loopback stack/);
    expect(appProofProblems(input(line({}, { NEXT_PUBLIC_SUPABASE_URL: null }))).join()).toMatch(/unset/);
    expect(appProofProblems(input(line({}, { DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" }))).join()).toMatch(/DATABASE_URL is not the harness's database/);
  });
  it("S2: the env proof is an ALLOWLIST: Jitter, Closer Lab, Sandra service and other credential-or-URL-looking names outside the list are refused", () => {
    expect(appProofProblems(input(line({ unexpectedEnv: undefined }))).join()).toMatch(/does not report unexpected environment names/);
    for (const name of ["JITTER_SOFTPHONE_BASE_URL", "JITTER_API_BASE_URL", "JITTER_SERVICE_TOKEN", "CLOSER_LAB_API_BASE_URL", "SANDRA_SERVICE_TOKEN", "DROPBOX_SIGN_API_KEY", "DIALPAD_API_KEY", "ANTHROPIC_BASE_URL"]) {
      expect(appProofProblems(input(line({ unexpectedEnv: [name] }))).join(), name).toMatch(new RegExp(`allowlist.*${name}`));
    }
    expect(appProofProblems(input(line({ unexpectedEnv: [] })))).toEqual([]);
  });
  it("S2: from a real process, sensitive-looking names off the list are reported (names only) and the allowlisted app settings are not", () => {
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), "allow-")), "g.jsonl");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", STRESS_EGRESS_LOG: log, NODE_OPTIONS: `--require "${path.join(__dirname, "egress-guard.cjs")}"`,
      // allowed
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55431", SUPABASE_SERVICE_ROLE_KEY: "s", DATABASE_URL: "postgresql://x@127.0.0.1:55430/p", CRON_SECRET: "c", DIALPAD_CTI_WEBHOOK_SECRET_E2E: "w", DIALPAD_CTI_DIAL_KEY_E2E: "d", DIALPAD_DIAL_PROVIDER: "", DROPBOX_SIGN_API_BASE_URL: "http://127.0.0.1:55500/dropbox-sign/v3", ESIGN_CREDENTIAL_ENCRYPTION_KEY: "e", MESSAGING_PROVIDER: "mock", NEXT_PUBLIC_HUGO_SSO: "1", NEXT_TELEMETRY_DISABLED: "1", E2E_AUTH_BYPASS: "1", STRESS_DIALPAD_STUB_URL: "http://127.0.0.1:55500",
      // not allowed
      NEXT_PRIVATE_WORKER: "1", __NEXT_PRIVATE_ORIGIN: "http://127.0.0.1:3466", SUPABASE_ACCESS_TOKEN: "tok",
      JITTER_SOFTPHONE_BASE_URL: "http://127.0.0.1:1", JITTER_SERVICE_TOKEN: "secret-value", CLOSER_LAB_API_BASE_URL: "http://x", SANDRA_SERVICE_TOKEN: "t", DROPBOX_SIGN_API_KEY: "k", SOME_THIRD_PARTY_WEBHOOK: "u",
    };
    spawnSync(process.execPath, ["-e", "0"], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
    const g = JSON.parse(readFileSync(log, "utf8").split("\n").filter(Boolean).pop()!) as { unexpectedEnv: string[] };
    expect(g.unexpectedEnv).toEqual(["CLOSER_LAB_API_BASE_URL", "DROPBOX_SIGN_API_KEY", "JITTER_SERVICE_TOKEN", "JITTER_SOFTPHONE_BASE_URL", "SANDRA_SERVICE_TOKEN", "SOME_THIRD_PARTY_WEBHOOK", "SUPABASE_ACCESS_TOKEN"]);
    expect(readFileSync(log, "utf8")).not.toContain("secret-value"); // values are never recorded
  });
  it("reach 3: the guard line itself reports forbidden names (names only), from a real process", () => {
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), "forb-")), "g.jsonl");
    spawnSync(process.execPath, ["-e", "0"], { env: { ...process.env, ...egressChildEnv(log), SENDILLO_API_KEY: "x", twilio_dummy: "y", TWILIO_SID: "z", HTTPS_PROXY: "http://p" } });
    const g = JSON.parse(readFileSync(log, "utf8").split("\n").filter(Boolean).pop()!) as { forbiddenPresent: string[] };
    expect(g.forbiddenPresent).toEqual(expect.arrayContaining(["SENDILLO_API_KEY", "TWILIO_SID", "HTTPS_PROXY"]));
    expect(JSON.stringify(g)).not.toMatch(/http:\/\/p"|"x"/); // values are never recorded
  });
  it("reach 5: ANY .env* file other than .env.example is refused (including .env.production*)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "envs2-"));
    writeFileSync(path.join(dir, ".env.example"), "x=1");
    expect(envFilesIn(dir)).toEqual([]);
    for (const f of [".env", ".env.local", ".env.production", ".env.production.local", ".env.test", ".env.development.local"]) writeFileSync(path.join(dir, f), "x=1");
    expect(envFilesIn(dir)).toEqual([".env", ".env.development.local", ".env.local", ".env.production", ".env.production.local", ".env.test"]);
    expect(appProofProblems(input(line(), { envFiles: [".env.production"] })).join()).toMatch(/\.env\.production/);
  });
  it("3 (spawn guard): the app must run the child-process guard; a non-Node child is denied and logged, Node children are not", () => {
    expect(appProofProblems(input(line({ spawnGuard: false }))).join()).toMatch(/child-process guard/);
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), "spawn-")), "g.jsonl");
    const code = `const cp=require("node:child_process");let denied="";try{cp.execFileSync("curl",["--version"])}catch(e){denied=e.code}let node="";try{node=cp.execFileSync(process.execPath,["-e","process.stdout.write('ok')"]).toString()}catch(e){node=e.code}let sh="";try{cp.execSync("echo hi")}catch(e){sh=e.code}let gitq="";try{cp.execSync("git rev-parse HEAD")}catch(e){gitq=e.code}let gitpush="";try{cp.execSync("git push origin HEAD")}catch(e){gitpush=e.code}let esb="";try{cp.execFileSync("/x/node_modules/@esbuild/darwin-arm64/bin/esbuild",["--version"])}catch(e){esb=e.code}let fakeEsb="";try{cp.execFileSync("/x/other/bin/esbuild",["--version"])}catch(e){fakeEsb=e.code}process.stdout.write(JSON.stringify({denied,node,sh,gitQueryNotDenied:gitq!=="EGRESS_DENIED",gitPushDenied:gitpush==="EGRESS_DENIED",esbuildNotDenied:esb!=="EGRESS_DENIED",lookalikeDenied:fakeEsb==="EGRESS_DENIED"}))`;
    const r = spawnSync(process.execPath, ["-e", code], { env: { ...process.env, ...egressChildEnv(log), STRESS_GUARD_SPAWN: "1" }, encoding: "utf8" });
    expect(JSON.parse(r.stdout)).toEqual({ denied: "EGRESS_DENIED", node: "ok", sh: "EGRESS_DENIED", gitQueryNotDenied: true, gitPushDenied: true, esbuildNotDenied: true, lookalikeDenied: true });
    expect(readFileSync(log, "utf8")).toMatch(/"kind":"spawn","target":"curl"/);
  });
});

describe("reach 4: the guard denies dns.promises.lookup and the dns.resolve* family for non-loopback names", () => {
  it("callback, promise and Resolver forms are all denied; loopback names are not", () => {
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), "dns-")), "g.jsonl");
    const code = `
      const dns=require("node:dns");const out={};
      const cbDeny=(fn,...a)=>new Promise((res)=>{try{fn(...a,(e)=>res(e&&e.code))}catch(e){res(e.code)}});
      (async()=>{
        out.promisesLookup=await dns.promises.lookup("example.com").then(()=>"NOT DENIED",(e)=>e.code);
        out.promisesResolve4=await dns.promises.resolve4("example.com").then(()=>"NOT DENIED",(e)=>e.code);
        out.resolve=await cbDeny(dns.resolve,"example.com");
        out.resolveTxt=await cbDeny(dns.resolveTxt,"example.com");
        out.reverse=await cbDeny(dns.reverse,"8.8.8.8");
        out.resolverClass=await new Promise((res)=>{try{new dns.Resolver().resolve4("example.com",(e)=>res(e&&e.code))}catch(e){res(e.code)}});
        out.loopback=await dns.promises.lookup("localhost").then(()=>"ok",(e)=>e.code);
        process.stdout.write(JSON.stringify(out));
      })();`;
    const r = spawnSync(process.execPath, ["-e", code], { env: { ...process.env, ...egressChildEnv(log), STRESS_EGRESS_PROBE: "1" }, encoding: "utf8" });
    expect(JSON.parse(r.stdout)).toEqual({ promisesLookup: "EGRESS_DENIED", promisesResolve4: "EGRESS_DENIED", resolve: "EGRESS_DENIED", resolveTxt: "EGRESS_DENIED", reverse: "EGRESS_DENIED", resolverClass: "EGRESS_DENIED", loopback: "ok" });
  });
});
