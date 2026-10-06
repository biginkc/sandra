import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { appEgressViolations, appProofProblems, parsePsEnv, proveAppUnderTest, type AppProofInput } from "./app-proof";
import { readConfig } from "./config";
import { GUARD_PATH, egressChildEnv } from "./egress";
import { buildManifest } from "./manifest";
import { LaneRefusal } from "./guards";
import { decide } from "./report";
import { faultCaught } from "./selftest";
import { leadPhone } from "./world";

const STUB = "http://127.0.0.1:55500";
const LOG = "/tmp/app-egress.jsonl";
const good = (over: Partial<AppProofInput> = {}): AppProofInput => ({
  env: { NODE_OPTIONS: `--require "${GUARD_PATH}"`, STRESS_EGRESS_LOG: LOG, DIALPAD_DIAL_PROVIDER: "stub", MESSAGING_PROVIDER: "mock", DROPBOX_SIGN_API_BASE_URL: `${STUB}/dropbox-sign/v3` },
  listenerPid: 4242,
  appEgressLog: LOG,
  logLines: [JSON.stringify({ kind: "guard_loaded", pid: 4242, probe: true })],
  stubUrl: STUB,
  ...over,
});

describe("(b)(c) the app under test is proven at T0", () => {
  it("a fully configured app has no problems", () => {
    expect(appProofProblems(good())).toEqual([]);
  });
  it("(b) refuses an app without the guard, with the log elsewhere, or with no guard_loaded line from its own pid", () => {
    expect(appProofProblems(good({ env: { ...good().env!, NODE_OPTIONS: "" } })).join()).toMatch(/does not carry the egress guard/);
    expect(appProofProblems(good({ env: { ...good().env!, STRESS_EGRESS_LOG: "/somewhere/else.jsonl" } })).join()).toMatch(/STRESS_EGRESS_LOG/);
    expect(appProofProblems(good({ logLines: [JSON.stringify({ kind: "guard_loaded", pid: 1, probe: true })] })).join()).toMatch(/guard_loaded/);
    expect(appProofProblems(good({ logLines: [] })).join()).toMatch(/guard_loaded/);
    expect(appProofProblems(good({ appEgressLog: "" })).join()).toMatch(/STRESS_APP_EGRESS_LOG is not set/);
    expect(appProofProblems(good({ listenerPid: null }))).toEqual(expect.arrayContaining([expect.stringMatching(/no process is listening/)]));
    expect(appProofProblems(good({ env: null })).join()).toMatch(/could not be read/);
  });
  it("(c) refuses non-stub providers; DIALPAD_DIAL_PROVIDER unset is the LIVE fallback and is refused", () => {
    const e = good().env!;
    const noDial = { ...e };
    delete noDial.DIALPAD_DIAL_PROVIDER;
    expect(appProofProblems(good({ env: noDial })).join()).toMatch(/DIALPAD_DIAL_PROVIDER is "unset".*LIVE/);
    expect(appProofProblems(good({ env: { ...e, DIALPAD_DIAL_PROVIDER: "live" } })).join()).toMatch(/DIALPAD_DIAL_PROVIDER/);
    expect(appProofProblems(good({ env: { ...e, MESSAGING_PROVIDER: "sendillo" } })).join()).toMatch(/MESSAGING_PROVIDER/);
    expect(appProofProblems(good({ env: { ...e, DROPBOX_SIGN_API_BASE_URL: "https://api.hellosign.com/v3" } })).join()).toMatch(/DROPBOX_SIGN_API_BASE_URL/);
    expect(appProofProblems(good({ env: { ...e, VERCEL_ENV: "production" } })).join()).toMatch(/VERCEL_ENV/);
  });
  it("the live proof refuses (LaneRefusal) when nothing listens on the app port", () => {
    expect(() => proveAppUnderTest({ appUrl: "http://127.0.0.1:59871", appEgressLog: LOG, stubUrl: STUB })).toThrow(LaneRefusal);
  });
  it("parses `ps eww` output whose NODE_OPTIONS value contains a space", () => {
    const env = parsePsEnv(`node next-server HOME=/Users/x NODE_OPTIONS=--require "/a b/e2e/stress/egress-guard.cjs" STRESS_EGRESS_LOG=/tmp/l.jsonl DIALPAD_DIAL_PROVIDER=stub npm_config_local_prefix=/x y`);
    expect(env.NODE_OPTIONS).toBe('--require "/a b/e2e/stress/egress-guard.cjs"');
    expect(env.DIALPAD_DIAL_PROVIDER).toBe("stub"); // a following lowercase key does not leak into the value
    expect(env.npm_config_local_prefix).toBe("/x y");
  });
  it("the guard announces itself with the pid of the process that loaded it", () => {
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), "guard-")), "app.jsonl");
    const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { env: { ...process.env, ...egressChildEnv(log) }, encoding: "utf8" });
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; pid: number });
    expect(lines.some((l) => l.kind === "guard_loaded" && l.pid === Number(r.stdout))).toBe(true);
  });
});

describe("(d) the app's egress log is read and any denial fails the run", () => {
  it("counts non-probe denials after the T0 offset, ignores probes and guard_loaded, and what came before T0", () => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), "appeg-")), "a.jsonl");
    const old = JSON.stringify({ kind: "connect", target: "old.example", probe: false }) + "\n";
    writeFileSync(f, old);
    const offset = old.length;
    writeFileSync(f, old + [{ kind: "guard_loaded", pid: 1, probe: true }, { kind: "connect", target: "api.dialpad.com", probe: false }, { kind: "dns", target: "x", probe: true }].map((j) => JSON.stringify(j)).join("\n") + "\n");
    expect(appEgressViolations(f, offset)).toEqual(["connect:api.dialpad.com"]);
    expect(appEgressViolations(f, 0)).toHaveLength(2);
    expect(appEgressViolations("/nonexistent/x.jsonl", 0)).toEqual([]);
  });
});

describe("(a) PASS requires the OS egress proof", () => {
  const cfg = readConfig({});
  const manifest = buildManifest(cfg.seed, cfg.runTag, { profile: "full" });
  const browserPlanned = manifest.ticks.filter((t) => t.actor === "browser").length;
  const run = (osEgressProven: boolean) => decide({ cfg, manifest, records: [], invariantChecks: [], outcomeChecks: [], egressViolations: 0, osEgressProven, serverProblems: [], killed: null, setupErrors: [], browserExecuted: browserPlanned });
  it("without it the best result is PARTIAL_PASS, with it PASS", () => {
    expect(run(false).verdict).toBe("PARTIAL_PASS");
    expect(run(false).reasons.join()).toMatch(/OS egress ring not proven/);
    expect(run(true).verdict).toBe("PASS");
  });
  it("an egress violation is a FAIL either way", () => {
    expect(decide({ cfg, manifest, records: [], invariantChecks: [], outcomeChecks: [], egressViolations: 1, osEgressProven: true, serverProblems: [], killed: null, setupErrors: [], browserExecuted: browserPlanned }).verdict).toBe("FAIL");
  });
});

describe("N2 self-test credit, N4 phones", () => {
  it("a fault that never fired earns no credit even when the check is red", () => {
    expect(faultCaught("drop_offer", [14], false)).toBe(false);
    expect(faultCaught("drop_offer", [14], true)).toBe(true);
    expect(faultCaught("drop_offer", [3], true)).toBe(false);
  });
  it("seeded phones stay inside 555-0100..0199", () => {
    for (const i of [0, 69, 98]) expect(leadPhone(i)).toMatch(/^\+1816555(01\d\d)$/);
    expect(() => leadPhone(99)).toThrow();
  });
});
