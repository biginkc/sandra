import { mkdtempSync, readFileSync, truncateSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { appBenignDenials, appEgressViolations, appProofProblems, checkoutDirtyReason, envFilesIn, guardLineFor, proveAppUnderTest, snapshotLog, type AppProofInput } from "./app-proof";
import { readConfig } from "./config";
import { egressChildEnv } from "./egress";
import { LaneRefusal } from "./guards";
import { faultCaught } from "./selftest";
import { leadPhone } from "./world";

const STUB = "http://127.0.0.1:55500";
const LOG = "/tmp/app-egress.jsonl";
const SHA = "a".repeat(40);
const guardLine = (over: Record<string, unknown> = {}) => JSON.stringify({
  kind: "guard_loaded", pid: 4242, probe: true, at: "2026-10-06T12:00:05.000Z", log: LOG, sha: SHA, dirty: false, redirect: STUB, spawnGuard: true, forbiddenPresent: [],
  env: { DIALPAD_DIAL_PROVIDER: null, MESSAGING_PROVIDER: "mock", DROPBOX_SIGN_API_BASE_URL: `${STUB}/dropbox-sign/v3`, VERCEL_ENV: null, VERCEL: null }, ...over,
});
const good = (over: Partial<AppProofInput> = {}): AppProofInput => ({ listenerPid: 4242, listenerUid: 501, harnessUid: 501, appEgressLog: LOG, logLines: [guardLine()], stubUrl: STUB, harnessSha: SHA, envFiles: [], listenerStartMs: Date.parse("2026-10-06T12:00:00.000Z"), ...over });
const withEnv = (env: Record<string, string | null>) => {
  const base = { MESSAGING_PROVIDER: "mock", DROPBOX_SIGN_API_BASE_URL: `${STUB}/dropbox-sign/v3`, DIALPAD_DIAL_PROVIDER: null, VERCEL_ENV: null, VERCEL: null };
  return good({ logLines: [guardLine({ env: { ...base, ...env } })] });
};

describe("(b)(c) the app under test is proven at T0 from its own guard line (F1: no ps parsing)", () => {
  it("a fully configured app has no problems", () => {
    expect(appProofProblems(good())).toEqual([]);
  });
  it("(b) refuses: no guard line from the listener's pid, wrong log, no listener, missing log", () => {
    expect(appProofProblems(good({ logLines: [guardLine({ pid: 1 })] })).join()).toMatch(/guard_loaded/);
    expect(appProofProblems(good({ logLines: [] })).join()).toMatch(/guard_loaded/);
    expect(appProofProblems(good({ logLines: [guardLine({ log: "/elsewhere.jsonl" })] })).join()).toMatch(/not STRESS_APP_EGRESS_LOG/);
    expect(appProofProblems(good({ appEgressLog: "" })).join()).toMatch(/STRESS_APP_EGRESS_LOG is not set/);
    expect(appProofProblems(good({ listenerPid: null }))).toEqual(expect.arrayContaining([expect.stringMatching(/no process is listening/)]));
  });
  it("(c) refuses non-stub providers and an undiverted Dialpad API", () => {
    expect(appProofProblems(withEnv({ DIALPAD_DIAL_PROVIDER: "stub" })).join()).toMatch(/keeps dials in process/);
    expect(appProofProblems(withEnv({ MESSAGING_PROVIDER: "sendillo" })).join()).toMatch(/MESSAGING_PROVIDER/);
    expect(appProofProblems(withEnv({ DROPBOX_SIGN_API_BASE_URL: "https://api.hellosign.com/v3" })).join()).toMatch(/DROPBOX_SIGN_API_BASE_URL/);
    expect(appProofProblems(withEnv({ VERCEL_ENV: "production" })).join()).toMatch(/VERCEL_ENV/);
    expect(appProofProblems(good({ logLines: [guardLine({ redirect: null })] })).join()).toMatch(/not diverted/);
  });
  it("N6: the app listener must run as the uid the pf rules cover", () => {
    expect(appProofProblems(good({ listenerUid: 502 })).join()).toMatch(/uid 502/);
    expect(appProofProblems(good({ listenerUid: null })).join()).toMatch(/unknown/);
  });
  it("#5: the app must run this checkout's commit with no tracked changes", () => {
    expect(appProofProblems(good({ logLines: [guardLine({ sha: "b".repeat(40) })] })).join()).toMatch(/runs commit/);
    expect(appProofProblems(good({ logLines: [guardLine({ sha: null })] })).join()).toMatch(/runs commit/);
    expect(appProofProblems(good({ logLines: [guardLine({ dirty: true })] })).join()).toMatch(/uncommitted/);
  });
  it("N1: a .env* file Next would load in the app checkout is refused (it could set provider env after the guard announced it)", () => {
    expect(appProofProblems(good({ envFiles: [".env.local"] })).join()).toMatch(/\.env\.local/);
    const dir = mkdtempSync(path.join(os.tmpdir(), "envs-"));
    writeFileSync(path.join(dir, ".env.example"), "x=1");
    expect(envFilesIn(dir)).toEqual([]); // .env.example is never loaded
    writeFileSync(path.join(dir, ".env.development.local"), "x=1");
    writeFileSync(path.join(dir, ".env"), "x=1");
    expect(envFilesIn(dir)).toEqual([".env", ".env.development.local"]);
  });
  it("N2: a guard line older than the listener process is a stale line from an earlier process (pid reuse), not this process's", () => {
    expect(appProofProblems(good({ listenerStartMs: Date.parse("2026-10-06T12:30:00.000Z") })).join()).toMatch(/stale line/);
    expect(appProofProblems(good({ listenerStartMs: null })).join()).toMatch(/older than the listener|unknown/);
    expect(appProofProblems(good({ logLines: [guardLine({ at: undefined })] })).join()).toMatch(/no time/);
  });
  it("N3: untracked files make the checkout dirty, build caches do not", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "repo-"));
    const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
    git("init", "-q"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
    writeFileSync(path.join(dir, "a.txt"), "1"); git("add", "."); git("commit", "-qm", "init");
    expect(checkoutDirtyReason(dir)).toBeNull();
    spawnSync("mkdir", ["-p", path.join(dir, ".swc")]); writeFileSync(path.join(dir, ".swc", "x"), "1");
    expect(checkoutDirtyReason(dir)).toBeNull(); // a build cache
    writeFileSync(path.join(dir, "new-route.ts"), "export {}");
    expect(checkoutDirtyReason(dir)).toMatch(/new-route\.ts/); // an untracked source file
  });
  it("the live proof refuses (LaneRefusal) when nothing listens on the app port", () => {
    expect(() => proveAppUnderTest({ appUrl: "http://127.0.0.1:59871", appEgressLog: LOG, stubUrl: STUB, harnessSha: SHA })).toThrow(LaneRefusal);
  });
  it("the guard announces pid, log, provider env, redirect and checkout identity from inside the process", () => {
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), "guard-")), "app.jsonl");
    const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { env: { ...process.env, ...egressChildEnv(log), MESSAGING_PROVIDER: "mock", STRESS_DIALPAD_STUB_URL: STUB }, encoding: "utf8" });
    const g = guardLineFor(readFileSync(log, "utf8").split("\n").filter(Boolean), Number(r.stdout))!;
    expect(g.log).toBe(log);
    expect(g.redirect).toBe(STUB);
    expect(g.env?.MESSAGING_PROVIDER).toBe("mock");
    expect(typeof g.sha === "string" || g.sha === null).toBe(true);
  });
  it("the guard's Dialpad redirect rewrites only the Dialpad API origin, to the loopback stub", () => {
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), "guard-")), "app.jsonl");
    const code = `const seen=[];globalThis.fetch=async(u)=>{seen.push(String(u));return {ok:true}};require(${JSON.stringify(path.resolve(__dirname, "egress-guard.cjs"))});(async()=>{await fetch("https://dialpad.com/api/v2/users/1/initiate_call");await fetch("http://127.0.0.1:9/x");process.stdout.write(JSON.stringify(seen))})()`;
    const r = spawnSync(process.execPath, ["-e", code], { env: { ...process.env, STRESS_EGRESS_LOG: log, STRESS_DIALPAD_STUB_URL: STUB }, encoding: "utf8" });
    expect(JSON.parse(r.stdout)).toEqual([`${STUB}/dialpad/api/v2/users/1/initiate_call`, "http://127.0.0.1:9/x"]);
    const off = spawnSync(process.execPath, ["-e", code.replace("STRESS_DIALPAD_STUB_URL", "X")], { env: { ...process.env, STRESS_EGRESS_LOG: log, STRESS_DIALPAD_STUB_URL: "https://evil.example" }, encoding: "utf8" });
    expect(JSON.parse(off.stdout)[0]).toBe("https://dialpad.com/api/v2/users/1/initiate_call"); // a non-loopback redirect target is refused: no redirect
  });
});

describe("(d) + #6 the app's egress log: denials fail the run, and so does losing the evidence", () => {
  const fresh = () => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), "appeg-")), "a.jsonl");
    writeFileSync(f, guardLine({ pid: 99 }) + "\n");
    return f;
  };
  it("counts non-probe denials after the T0 snapshot and ignores probes, guard_loaded and what came before", () => {
    const f = fresh();
    const snap = snapshotLog(f)!;
    appendFileSync(f, [{ kind: "guard_loaded", pid: 1, probe: true }, { kind: "connect", target: "dialpad.com", probe: false }, { kind: "dns", target: "x", probe: true }].map((j) => JSON.stringify(j)).join("\n") + "\n");
    expect(appEgressViolations(f, snap, 99)).toEqual(["connect:dialpad.com"]);
  });
  it("the Next dev server's own npm version check is the one tolerated denial; any other host, including a provider, is not", () => {
    const f = fresh();
    const snap = snapshotLog(f)!;
    appendFileSync(f, [{ kind: "tls", target: "registry.npmjs.org", probe: false }, { kind: "tls", target: "dialpad.com", probe: false }, { kind: "tls", target: "registry.npmjs.org.evil.example", probe: false }].map((j) => JSON.stringify(j)).join("\n") + "\n");
    expect(appEgressViolations(f, snap, 99)).toEqual(["tls:dialpad.com", "tls:registry.npmjs.org.evil.example"]);
  });
  it("N4: the tolerated npm-registry denials are counted so the report can show them", () => {
    const f = fresh();
    const snap = snapshotLog(f)!;
    appendFileSync(f, [{ kind: "tls", target: "registry.npmjs.org", probe: false }, { kind: "dns", target: "registry.npmjs.org", probe: false }, { kind: "tls", target: "dialpad.com", probe: false }].map((j) => JSON.stringify(j)).join("\n") + "\n");
    expect(appBenignDenials(f, snap)).toBe(2);
    expect(appBenignDenials(f, null)).toBe(0);
  });
  it("a deleted log is a violation, not zero violations (Astra #6)", () => {
    const f = fresh();
    const snap = snapshotLog(f)!;
    unlinkSync(f);
    expect(appEgressViolations(f, snap, 99).join()).toMatch(/missing/);
  });
  it("a truncated log is a violation", () => {
    const f = fresh();
    appendFileSync(f, JSON.stringify({ kind: "connect", target: "x", probe: false }) + "\n");
    const snap = snapshotLog(f)!;
    truncateSync(f, 10);
    expect(appEgressViolations(f, snap, 99).join()).toMatch(/truncated/);
  });
  it("a replaced log (new inode, even if larger) is a violation", () => {
    const f = fresh();
    const snap = snapshotLog(f)!;
    unlinkSync(f);
    writeFileSync(f, guardLine({ pid: 99 }) + "\n" + "x".repeat(500) + "\n");
    expect(appEgressViolations(f, snap, 99).join()).toMatch(/replaced/);
  });
  it("a log that lost the app's own guard_loaded line, or was never snapshotted, is a violation", () => {
    const f = fresh();
    const snap = snapshotLog(f)!;
    writeFileSync(f, JSON.stringify({ kind: "noise", probe: true }) + "\n".padEnd(snap.size, " ") + "\n");
    expect(appEgressViolations(f, { ino: snap.ino, size: snap.size }, 99).join()).toMatch(/guard_loaded line is gone/);
    expect(appEgressViolations(f, null, 99).join()).toMatch(/never snapshotted/);
  });
});

describe("#5 the sha is the checkout's, never the caller's", () => {
  it("is derived from git HEAD; an env STRESS_SHA that differs is refused, one that matches is harmless", () => {
    expect(readConfig({}, { headSha: () => SHA }).sha).toBe(SHA);
    expect(() => readConfig({ STRESS_SHA: "b".repeat(40) }, { headSha: () => SHA })).toThrow(/does not match git HEAD/);
    expect(readConfig({ STRESS_SHA: SHA }, { headSha: () => SHA }).sha).toBe(SHA);
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
