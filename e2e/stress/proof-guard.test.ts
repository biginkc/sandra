import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildManifest, toNdjson } from "./manifest";
import { PROOF_EXEMPT_SPECS, PROOF_FILE, assertLiveRecheck, assertRunBoundAppProof, newRunSecrets, proofChildEnv, signProof, writeAppProof, type GuardDeps, type ProofFields } from "./proof-guard";

const SHA = "a".repeat(40);
const STUB = "http://127.0.0.1:55500";
const LOG = "/tmp/app-egress.jsonl";
const START = Date.parse("2026-10-06T12:00:00.000Z");
const NOW = Date.parse("2026-10-06T12:30:00.000Z");
const SECRETS = { key: "k".repeat(64), nonce: "n".repeat(64) };
const fields = (over: Partial<ProofFields> = {}): ProofFields => ({
  v: 1, runId: "run1", runTag: "STRESS-run1", nonce: SECRETS.nonce, sha: SHA, startedAt: new Date(NOW - 60_000).toISOString(), engineHost: "h",
  appPid: 4242, appListenerStartMs: START, appEgressLog: LOG, appEgressLogIno: 7, appEgressLogSizeAtT0: 100, stubUrl: STUB, proxyUrl: "http://localhost:1", osEgressProven: false, ...over,
});
const guardLine = (over: Record<string, unknown> = {}) => JSON.stringify({
  kind: "guard_loaded", pid: 4242, at: "2026-10-06T12:00:05.000Z", log: LOG, sha: SHA, dirty: false, redirect: STUB, cwd: "/app",
  env: { DIALPAD_DIAL_PROVIDER: null, MESSAGING_PROVIDER: "mock", DROPBOX_SIGN_API_BASE_URL: `${STUB}/dropbox-sign/v3`, VERCEL_ENV: null, VERCEL: null }, ...over,
});

function deps(over: { proof?: ReturnType<typeof signProof> | null; env?: Record<string, string | undefined>; head?: string; live?: Partial<ReturnType<GuardDeps["live"]>>; violations?: string[]; logStat?: { ino: number; size: number } | null } = {}): GuardDeps {
  const proof = over.proof === undefined ? signProof(fields(), SECRETS.key) : over.proof;
  return {
    env: { STRESS_RUN_DIR: "/run", STRESS_PROOF_KEY: SECRETS.key, STRESS_PROOF_NONCE: SECRETS.nonce, STRESS_RUN_ID: "run1", STRESS_RUN_TAG: "STRESS-run1", STRESS_APP_URL: "http://127.0.0.1:3466", ...over.env },
    readFile: (p) => (proof && p === `/run/${PROOF_FILE}` ? JSON.stringify(proof) : null),
    headSha: () => over.head ?? SHA,
    now: () => NOW,
    live: () => ({ pid: 4242, uid: 501, startMs: START, lines: [guardLine()], envFiles: [], ...over.live }),
    logStat: () => (over.logStat === undefined ? { ino: 7, size: 200 } : over.logStat),
    readLog: () => [],
    harnessUid: 501,
    violations: () => over.violations ?? [],
  };
}
const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { return `${(e as { code?: string }).code}: ${(e as Error).message}`; } return null; };

describe("(c) the browser specs cannot mutate without a run-bound, live app-egress proof", () => {
  it("c1 Astra: a direct run whose run dir has world/schedule files but NO proof is refused", () => {
    expect(refusal(() => assertRunBoundAppProof(deps({ proof: null })))).toMatch(/APP_EGRESS_PROOF_MISSING.*no app-proof\.json/);
    expect(refusal(() => assertRunBoundAppProof(deps({ env: { STRESS_RUN_DIR: undefined } })))).toMatch(/APP_EGRESS_PROOF_MISSING/);
  });
  it("c2 a proof file without the per-run key in the environment is refused", () => {
    expect(refusal(() => assertRunBoundAppProof(deps({ env: { STRESS_PROOF_KEY: undefined } })))).toMatch(/APP_EGRESS_PROOF_MISSING/);
    expect(refusal(() => assertRunBoundAppProof(deps({ env: { STRESS_PROOF_NONCE: undefined } })))).toMatch(/APP_EGRESS_PROOF_MISSING/);
  });
  it("c3 a proof with one edited field fails the HMAC (MISMATCH)", () => {
    const good = signProof(fields(), SECRETS.key);
    expect(refusal(() => assertRunBoundAppProof(deps({ proof: { ...good, appPid: 1 } })))).toMatch(/APP_EGRESS_PROOF_MISMATCH.*does not verify/);
    expect(refusal(() => assertRunBoundAppProof(deps({ proof: signProof(fields(), "x".repeat(64)) })))).toMatch(/MISMATCH/);
  });
  it("c4 a proof from an earlier run (same seed and run id, different nonce) is STALE", () => {
    const old = signProof(fields({ nonce: "o".repeat(64) }), SECRETS.key);
    expect(refusal(() => assertRunBoundAppProof(deps({ proof: old })))).toMatch(/APP_EGRESS_PROOF_STALE.*earlier run/);
    expect(refusal(() => assertRunBoundAppProof(deps({ proof: signProof(fields({ startedAt: new Date(NOW - 7 * 3600_000).toISOString() }), SECRETS.key) })))).toMatch(/STALE.*older than/);
  });
  it("c5 a proof for another commit is refused", () => {
    expect(refusal(() => assertRunBoundAppProof(deps({ head: "b".repeat(40) })))).toMatch(/MISMATCH.*commit/);
  });
  it("c6 a different listener pid (the app was restarted) is refused", () => {
    expect(refusal(() => assertRunBoundAppProof(deps({ live: { pid: 9999 } })))).toMatch(/STALE.*restarted/);
    expect(refusal(() => assertRunBoundAppProof(deps({ live: { pid: null } })))).toMatch(/STALE/);
  });
  it("c7 the same pid with a different start time (pid reuse) is refused", () => {
    expect(refusal(() => assertRunBoundAppProof(deps({ live: { startMs: START + 60_000 } })))).toMatch(/STALE.*start time/);
  });
  it("c8 a replaced or truncated egress log, or a new provider denial, is refused", () => {
    expect(refusal(() => assertRunBoundAppProof(deps({ logStat: null })))).toMatch(/MISMATCH.*missing/);
    expect(refusal(() => assertRunBoundAppProof(deps({ violations: ["app egress log was replaced (inode changed)"] })))).toMatch(/MISMATCH.*replaced/);
    expect(refusal(() => assertRunBoundAppProof(deps({ violations: ["tls:dialpad.com"] })))).toMatch(/violation\(s\) since T0: tls:dialpad\.com/);
  });
  it("c9 a listener whose guard line now shows a non-mock provider (restarted with a live adapter) is refused via appProofProblems", () => {
    const live = { lines: [guardLine({ env: { MESSAGING_PROVIDER: "live", DIALPAD_DIAL_PROVIDER: null, DROPBOX_SIGN_API_BASE_URL: `${STUB}/dropbox-sign/v3`, VERCEL_ENV: null, VERCEL: null } })] };
    expect(refusal(() => assertRunBoundAppProof(deps({ live })))).toMatch(/MISMATCH.*MESSAGING_PROVIDER/);
  });
  it("c10 everything valid returns the proof, and the per-test recheck passes", () => {
    const d = deps();
    const proof = assertRunBoundAppProof(d);
    expect(proof.appPid).toBe(4242);
    expect(() => assertLiveRecheck(proof, d)).not.toThrow();
    expect(refusal(() => assertLiveRecheck(proof, deps({ live: { pid: 1 } })))).toMatch(/STALE/);
  });
  it("notes: the age check is finite and non-negative; run id and tag must be set; malformed or `null` JSON is a LaneRefusal, not a TypeError", () => {
    expect(refusal(() => assertRunBoundAppProof(deps({ proof: signProof(fields({ startedAt: "not a date" }), SECRETS.key) })))).toMatch(/STALE.*unreadable/);
    expect(refusal(() => assertRunBoundAppProof(deps({ proof: signProof(fields({ startedAt: new Date(NOW + 3600_000).toISOString() }), SECRETS.key) })))).toMatch(/STALE.*future/);
    expect(refusal(() => assertRunBoundAppProof(deps({ env: { STRESS_RUN_ID: undefined } })))).toMatch(/MISSING.*STRESS_RUN_ID/);
    expect(refusal(() => assertRunBoundAppProof(deps({ env: { STRESS_RUN_TAG: undefined } })))).toMatch(/MISSING.*STRESS_RUN_TAG/);
    const d = deps();
    for (const text of ["null", "[]", "42", "{", "{\"mac\":1}"]) {
      const out = refusal(() => assertRunBoundAppProof({ ...d, readFile: (p) => (p.endsWith(PROOF_FILE) ? text : null) }));
      expect(out, text).toMatch(/^APP_EGRESS_PROOF_MISMATCH/);
    }
  });
  it("c15 the engine's proof is written and signed with a per-run key; only the child env carries the key and nonce", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "proofdir-"));
    const s = newRunSecrets();
    const { runId: _r, ...rest } = fields();
    void _r;
    const proof = writeAppProof(dir, { ...rest, runId: "run1", nonce: s.nonce }, s.key);
    const onDisk = readFileSync(path.join(dir, PROOF_FILE), "utf8");
    expect(onDisk).not.toContain(s.key); // the key is never written to disk
    expect(JSON.parse(onDisk).mac).toBe(proof.mac);
    expect(proofChildEnv(s)).toEqual({ STRESS_PROOF_KEY: s.key, STRESS_PROOF_NONCE: s.nonce });
    expect(newRunSecrets().key).not.toBe(s.key);
    expect(newRunSecrets().nonce).not.toBe(s.nonce);
  });
});

const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");
const specs = readdirSync(path.join(__dirname, "browser")).filter((f) => f.endsWith(".spec.ts"));

describe("(c) static: the guard cannot be bypassed by how a spec is written", () => {
  it("c11 every spec except the exempt list imports `test` from ./fixtures, never from @playwright/test", () => {
    expect(PROOF_EXEMPT_SPECS).toEqual(["live-leg.spec.ts"]);
    for (const f of specs.filter((x) => !PROOF_EXEMPT_SPECS.includes(x))) {
      const src = read(`browser/${f}`);
      expect(src, f).toMatch(/from "\.\/fixtures"/);
      expect(src, f).not.toMatch(/import\s*\{[^}]*\btest\b[^}]*\}\s*from "@playwright\/test"/);
    }
  });
  it("c12 no spec builds the run (database, stub control) at module scope", () => {
    for (const f of specs.filter((x) => !PROOF_EXEMPT_SPECS.includes(x))) {
      const src = read(`browser/${f}`);
      expect(src, f).not.toMatch(/^(const|let)\s+\w+\s*=\s*loadRun\(/m);
      expect(src, f).not.toMatch(/\bloadRun\(/); // only the fixture calls it, with the proof
    }
    expect(read("browser/support.ts")).toMatch(/export function loadRun\(proof: AppProof\)/);
  });
  it("c13 playwright.stress.config.ts declares the config-level globalSetup guard, and that file runs the proof", () => {
    expect(readFileSync(path.join(__dirname, "../../playwright.stress.config.ts"), "utf8")).toMatch(/globalSetup:\s*"\.\/e2e\/stress\/browser\/global-setup\.ts"/);
    expect(read("browser/global-setup.ts")).toMatch(/assertRunBoundAppProof\(\)/);
    expect(read("browser/fixtures.ts")).toMatch(/auto: true/);
    expect(read("browser/fixtures.ts")).toMatch(/assertLiveRecheck/);
  });
  it("c14 the default playwright.config.ts ignores the stress specs (pinned)", () => {
    expect(readFileSync(path.join(__dirname, "../../playwright.config.ts"), "utf8")).toMatch(/"\*\*\/stress\/\*\*"/);
  });
  it("the engine writes the proof only after proveAppUnderTest and hands the key to the child through proofChildEnv", () => {
    const eng = read("engine.ts");
    expect(eng.indexOf("writeAppProof(")).toBeGreaterThan(eng.indexOf("proveAppUnderTest("));
    expect(eng).toMatch(/proofChildEnv\(secrets\)/);
    expect(eng).toMatch(/"app-proof\.json"/); // removed at the start of every run
  });
});

describe("(c) integration: real Playwright refuses a direct run before any request or database write", () => {
  const root = path.join(__dirname, "../..");
  const setup = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "directrun-"));
    const m = buildManifest(20261005, "STRESS-direct", { profile: "short" });
    writeFileSync(path.join(dir, "schedule.ndjson"), toNdjson(m));
    writeFileSync(path.join(dir, "world.json"), JSON.stringify({ orgId: "o", repUserId: "u", connectionId: "c", templateId: "t", leads: [] }));
    return { dir, env: {
      ...process.env, STRESS_HARNESS: "1", STRESS_PROXY_URL: "http://localhost:59999", STRESS_RUN_DIR: dir, STRESS_SCHEDULE_FILE: path.join(dir, "schedule.ndjson"), STRESS_WORLD_FILE: path.join(dir, "world.json"),
      STRESS_STUB_URL: "http://127.0.0.1:59998", STRESS_APP_URL: "http://127.0.0.1:59871", E2E_DISPOSABLE_DATABASE: "1", E2E_CI_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:59997/postgres",
      TEST_SUPABASE_URL: "http://127.0.0.1:59996", STRESS_SUPABASE_URL: "http://127.0.0.1:59996", E2E_CRON_SECRET: "x".repeat(20), DIALPAD_CTI_WEBHOOK_SECRET_E2E: "y".repeat(20),
      STRESS_REP_EMAIL: "rep@bmhgroupkc.com", STRESS_REP_PASSWORD: "p", NODE_OPTIONS: "",
    } as NodeJS.ProcessEnv };
  };
  const run = (args: string[]) => {
    const { dir, env } = setup();
    const r = spawnSync("npx", ["playwright", "test", "-c", "playwright.stress.config.ts", ...args], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}`, dir };
  };
  it("c16 direct execution of chaos-browser.spec.ts fails in the guard, runs no test, and writes no result", () => {
    const r = run(["e2e/stress/browser/chaos-browser.spec.ts"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/APP_EGRESS_PROOF_MISSING|no app-proof\.json/);
    expect(r.out).not.toMatch(/stress t\d+ /); // no tick ran
    expect(readdirSync(r.dir).includes("browser-results.jsonl")).toBe(false);
  }, 130_000);
  it("c17 --no-deps and --grep do not skip the guard", () => {
    const r = run(["e2e/stress/browser/chaos-browser.spec.ts", "--no-deps", "--grep", "clean_call"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/APP_EGRESS_PROOF_MISSING|no app-proof\.json/);
    const p = run(["e2e/stress/browser/rendered-parity.spec.ts", "--no-deps"]);
    expect(p.code).not.toBe(0);
    expect(p.out).toMatch(/APP_EGRESS_PROOF_MISSING|no app-proof\.json/);
  }, 260_000);
});
