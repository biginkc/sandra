import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { appEgressViolations, appProofProblems, collectLiveAppFacts, type LiveAppFacts, type LogSnapshot } from "./app-proof";
import { gitHeadSha } from "./config";
import { LaneRefusal } from "./guards";

/**
 * No browser mutation without a RUN-BOUND, LIVE proof about the app's server-side egress. The engine proves the app at T0 (`proveAppUnderTest`) and
 * writes `<runDir>/app-proof.json`, HMAC-signed with a per-run key that exists only in the engine's memory and the Playwright child's environment.
 * The Playwright side verifies it in config-level `globalSetup` AND in an auto fixture before every test (neither can be skipped with a CLI flag,
 * unlike a setup project and `--no-deps`), and re-checks the LIVE app each time: same listener pid and start time, log not replaced or truncated,
 * no denial since T0. Honest limit: the HMAC stops accidental reuse (a stale file, a direct run, another run's directory), not someone who forges
 * both the file and the key; that is why the live re-verification exists.
 */

export const PROOF_FILE = "app-proof.json";
export const MAX_RUN_MS = 6 * 3600_000;

export type ProofFields = {
  v: 1; runId: string; runTag: string; nonce: string; sha: string; startedAt: string; engineHost: string;
  appPid: number; appListenerStartMs: number; appEgressLog: string; appEgressLogIno: number; appEgressLogSizeAtT0: number;
  stubUrl: string; proxyUrl: string; osEgressProven: boolean;
};
export type AppProof = ProofFields & { mac: string };

const canonical = (f: ProofFields) => JSON.stringify(Object.fromEntries(Object.entries(f).sort(([a], [b]) => (a < b ? -1 : 1))));
export const signProof = (f: ProofFields, key: string): AppProof => ({ ...f, mac: createHmac("sha256", key).update(canonical(f)).digest("hex") });
export function macOk(p: AppProof, key: string): boolean {
  const { mac, ...fields } = p;
  const want = createHmac("sha256", key).update(canonical(fields as ProofFields)).digest();
  try { return timingSafeEqual(want, Buffer.from(mac, "hex")); } catch { return false; }
}

/** Per-run secrets: the key never touches disk; the nonce is in the file and the env so a proof from an earlier run (same seed, same run id) is stale. */
export function newRunSecrets(): { key: string; nonce: string } {
  return { key: randomBytes(32).toString("hex"), nonce: randomBytes(32).toString("hex") };
}
/** The environment of the Playwright child: the only place the key lives besides the engine's memory. */
export function proofChildEnv(s: { key: string; nonce: string }): Record<string, string> {
  return { STRESS_PROOF_KEY: s.key, STRESS_PROOF_NONCE: s.nonce };
}

/** Written by the engine right after `proveAppUnderTest` succeeds. */
export function writeAppProof(runDir: string, fields: Omit<ProofFields, "v" | "engineHost" | "startedAt" | "sha"> & { sha: string }, key: string): AppProof {
  const proof = signProof({ ...fields, v: 1, engineHost: os.hostname(), startedAt: new Date().toISOString() }, key);
  writeFileSync(path.join(runDir, PROOF_FILE), JSON.stringify(proof, null, 1), { mode: 0o600 });
  return proof;
}

export type GuardDeps = {
  env: Readonly<Record<string, string | undefined>>;
  readFile: (p: string) => string | null;
  headSha: () => string;
  now: () => number;
  live: (appUrl: string, appEgressLog: string) => LiveAppFacts;
  logStat: (file: string) => LogSnapshot | null;
  readLog: (file: string) => string[];
  harnessUid: number;
  /** Used for the egress-violation scan against the T0 snapshot. */
  violations: (file: string, snap: LogSnapshot, pid: number) => string[];
};

export const realGuardDeps = (): GuardDeps => ({
  env: process.env,
  readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  headSha: gitHeadSha,
  now: Date.now,
  live: collectLiveAppFacts,
  logStat: (f) => (existsSync(f) ? { ino: statSync(f).ino, size: statSync(f).size } : null),
  readLog: (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []),
  harnessUid: process.getuid?.() ?? -1,
  violations: (file, snap, pid) => appEgressViolations(file, snap, pid),
});

const refuse = (code: "APP_EGRESS_PROOF_MISSING" | "APP_EGRESS_PROOF_STALE" | "APP_EGRESS_PROOF_MISMATCH", msg: string): never => { throw new LaneRefusal(code, msg); };

/** Step 1: the file is the engine's, for THIS run, signed, fresh, for this checkout. Returns the proof. */
export function verifySignedProof(d: GuardDeps): AppProof {
  const dir = d.env.STRESS_RUN_DIR;
  const key = d.env.STRESS_PROOF_KEY;
  const nonce = d.env.STRESS_PROOF_NONCE;
  if (!dir) return refuse("APP_EGRESS_PROOF_MISSING", "STRESS_RUN_DIR is not set: the browser specs run only under the engine (npm run stress -- run).");
  const text = d.readFile(path.join(dir, PROOF_FILE));
  if (!text) return refuse("APP_EGRESS_PROOF_MISSING", `no ${PROOF_FILE} in ${dir}: the engine has not proven the app's egress for this run; browser mutations are refused.`);
  if (!key || !nonce) return refuse("APP_EGRESS_PROOF_MISSING", "STRESS_PROOF_KEY / STRESS_PROOF_NONCE are not set: only the engine starts the browser lane.");
  let proof: AppProof;
  try { proof = JSON.parse(text) as AppProof; } catch { return refuse("APP_EGRESS_PROOF_MISMATCH", `${PROOF_FILE} is not valid JSON`); }
  if (!macOk(proof, key)) return refuse("APP_EGRESS_PROOF_MISMATCH", `${PROOF_FILE} does not verify against this run's key (edited, or from another run).`);
  if (proof.nonce !== nonce) return refuse("APP_EGRESS_PROOF_STALE", `${PROOF_FILE} is from an earlier run (nonce differs).`);
  if (proof.sha !== d.headSha()) return refuse("APP_EGRESS_PROOF_MISMATCH", `the proof is for commit ${proof.sha}, this checkout is ${d.headSha()}.`);
  if (d.env.STRESS_RUN_ID && d.env.STRESS_RUN_ID !== proof.runId) return refuse("APP_EGRESS_PROOF_MISMATCH", "the proof's run id is not this run's.");
  if (d.env.STRESS_RUN_TAG && d.env.STRESS_RUN_TAG !== proof.runTag) return refuse("APP_EGRESS_PROOF_MISMATCH", "the proof's run tag is not this run's.");
  if (d.now() - Date.parse(proof.startedAt) > MAX_RUN_MS) return refuse("APP_EGRESS_PROOF_STALE", "the proof is older than the maximum run length.");
  return proof;
}

/** Steps 2-3: the app is STILL the one that was proven (same pid, same start time), still clean, still logging, and has denied nothing since T0. */
export function verifyLiveApp(proof: AppProof, d: GuardDeps): void {
  const appUrl = d.env.STRESS_APP_URL ?? "";
  const facts = d.live(appUrl, proof.appEgressLog);
  if (facts.pid !== proof.appPid) refuse("APP_EGRESS_PROOF_STALE", `the app listener is pid ${facts.pid ?? "none"}, the proof was for pid ${proof.appPid}: the app was restarted since T0.`);
  if (facts.startMs !== proof.appListenerStartMs) refuse("APP_EGRESS_PROOF_STALE", "the app listener's start time differs from the proof (pid reuse or restart).");
  const problems = appProofProblems({
    listenerPid: facts.pid, listenerUid: facts.uid, harnessUid: d.harnessUid, appEgressLog: proof.appEgressLog, logLines: facts.lines,
    stubUrl: proof.stubUrl, harnessSha: d.headSha(), envFiles: facts.envFiles, listenerStartMs: facts.startMs,
  });
  if (problems.length) refuse("APP_EGRESS_PROOF_MISMATCH", `the app no longer satisfies the egress proof: ${problems.join(" | ")}`);
  const snap = d.logStat(proof.appEgressLog);
  if (!snap) refuse("APP_EGRESS_PROOF_MISMATCH", "the app egress log is missing");
  const viol = d.violations(proof.appEgressLog, { ino: proof.appEgressLogIno, size: proof.appEgressLogSizeAtT0 }, proof.appPid);
  if (viol.length) refuse("APP_EGRESS_PROOF_MISMATCH", `app egress violation(s) since T0: ${viol.join(", ")}`);
}

/** The whole guard: signed proof first, then the live app. Used by globalSetup and (as the worker proof) by the auto fixture. */
export function assertRunBoundAppProof(d: GuardDeps = realGuardDeps()): AppProof {
  const proof = verifySignedProof(d);
  verifyLiveApp(proof, d);
  return proof;
}

/** Cheap per-test re-check (one lsof, one ps, one file read). */
export function assertLiveRecheck(proof: AppProof, d: GuardDeps = realGuardDeps()): void {
  verifyLiveApp(proof, d);
}

/** The only spec allowed to run without the proof: its app intentionally reaches real providers and is gated by assertLiveLegReady instead. */
export const PROOF_EXEMPT_SPECS: readonly string[] = ["live-leg.spec.ts"];
