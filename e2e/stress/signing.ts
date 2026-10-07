import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Signed, run-bound, short-lived evidence for the live leg. The stub-leg report and the self-test report each carry (runId, sha, kind, timestamp, hash
 * of the content) and an HMAC made by the ENGINE with a key that never lives in the repo: an `op read` of STRESS_REPORT_KEY_OP_REF (BMH Secrets vault) with the
 * service account; only the stubbed lane may use a local test key file (see loadReportKey). The live leg refuses unsigned, tampered, wrong-sha, wrong-run or stale (>24 h)
 * evidence, and refuses the sha "unknown" everywhere.
 */

export const MAX_EVIDENCE_AGE_MS = 24 * 3600_000;
export type EvidenceKind = "stub_leg" | "selftest";
/** `verdict`, `profile`, `scope`, `fault` and `appGuardPid` are part of the SIGNED payload (stub_leg): the live leg reads them from here, never from a regex over the report text. */
export type EvidenceMeta = { v: 1; kind: EvidenceKind; runId: string; sha: string; at: string; subjectSha256: string; verdict?: string; profile?: string; scope?: string; fault?: string; appGuardPid?: number | null };
export type SignedEvidence = EvidenceMeta & { hmac: string };

/** The pin of an owned number: HMAC under the report key, so a committed pin cannot be brute-forced like a bare sha256 of a 10-digit number. */
export const numberPin = (number: string, key: string) => createHmac("sha256", key).update(`owned-number:${number}`).digest("hex");
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const canonical = (m: EvidenceMeta) => JSON.stringify(Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1))));
export const signEvidence = (m: EvidenceMeta, key: string): SignedEvidence => ({ ...m, hmac: createHmac("sha256", key).update(canonical(m)).digest("hex") });

export type KeyDeps = { readFile?: (p: string) => string | null; mode?: (p: string) => number | null; repoRoot?: string; opRead?: (ref: string) => string; realpath?: (p: string) => string; isInsideCheckout?: (realDir: string) => boolean };
/** "live" (the default, the strictest) takes the key ONLY from the 1Password service account. "stub" may also take a local test key file. */
export type KeyLane = "live" | "stub";
export const OP_KEY_VAULT_PREFIX = "op://BMH Secrets/";

/** True when `dir` is inside a git worktree or checkout (any ancestor holds a `.git` entry) or inside this repo's root. */
function insideAnyCheckout(realDir: string, repoRoot: string): boolean {
  if (realDir === repoRoot || realDir.startsWith(repoRoot + path.sep)) return true;
  for (let d = realDir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/**
 * The signing/pin key, or null when none is configured. The live leg and the pin tool load it ONLY through the op service account: an op:// ref in
 * the BMH Secrets vault with OP_SERVICE_ACCOUNT_TOKEN present (STRESS_REPORT_KEY_FILE is gone). The stubbed lane alone may use a local TEST key file
 * (STRESS_TEST_KEY_FILE): absolute, realpath-resolved, mode 0600, at least 32 characters, and never inside any git worktree or checkout (this repo's or
 * any other). Naming a test key file in the live lane is refused, not ignored.
 */
export function loadReportKey(env: Readonly<Record<string, string | undefined>>, deps: KeyDeps = {}, lane: KeyLane = "live"): string | null {
  if (env.STRESS_REPORT_KEY_FILE) throw new Error("STRESS_REPORT_KEY_FILE is no longer supported: set STRESS_REPORT_KEY_OP_REF (an op:// ref in the BMH Secrets vault)");
  const file = env.STRESS_TEST_KEY_FILE;
  if (file && lane === "live") throw new Error("STRESS_TEST_KEY_FILE is for the stubbed lane only: the live leg takes its key only from the op service account");
  if (file) {
    if (!path.isAbsolute(file)) throw new Error("STRESS_TEST_KEY_FILE must be an absolute path");
    let real: string;
    try { real = (deps.realpath ?? realpathSync)(file); } catch { throw new Error("STRESS_TEST_KEY_FILE does not exist"); }
    const root = (deps.repoRoot ?? path.resolve(__dirname, "../.."));
    const realRoot = (() => { try { return (deps.realpath ?? realpathSync)(root); } catch { return root; } })();
    const inside = deps.isInsideCheckout ?? ((d: string) => insideAnyCheckout(d, realRoot));
    if (inside(path.dirname(real))) throw new Error("STRESS_TEST_KEY_FILE must be outside every git worktree and checkout (including this repository)");
    const mode = (deps.mode ?? ((p) => (existsSync(p) ? statSync(p).mode & 0o777 : null)))(real);
    if (mode === null) throw new Error("STRESS_TEST_KEY_FILE does not exist");
    if ((mode & 0o077) !== 0) throw new Error("STRESS_TEST_KEY_FILE must be mode 0600 (no group or other access)");
    const key = ((deps.readFile ?? ((p) => readFileSync(p, "utf8")))(real) ?? "").trim();
    if (key.length < 32) throw new Error("STRESS_TEST_KEY_FILE holds a key shorter than 32 characters");
    return key;
  }
  const ref = env.STRESS_REPORT_KEY_OP_REF;
  if (ref) {
    if (!env.OP_SERVICE_ACCOUNT_TOKEN) throw new Error("OP_SERVICE_ACCOUNT_TOKEN is not set: refusing to run `op read`");
    if (!ref.startsWith(OP_KEY_VAULT_PREFIX) || /[\s]/.test(ref.slice(OP_KEY_VAULT_PREFIX.length)) || ref.length === OP_KEY_VAULT_PREFIX.length) throw new Error(`STRESS_REPORT_KEY_OP_REF must be an ${OP_KEY_VAULT_PREFIX}... reference`);
    const key = (deps.opRead ?? ((r) => execFileSync("op", ["read", "--no-newline", r], { encoding: "utf8", timeout: 20_000 })))(ref).trim();
    if (key.length < 32) throw new Error("the op-stored report key is shorter than 32 characters");
    return key;
  }
  return null;
}

/** Problems with a piece of evidence (empty = acceptable). `subjectText` is the content the signature must cover. */
export function evidenceProblems(doc: SignedEvidence | null, key: string | null, want: { kind: EvidenceKind; sha: string; subjectText: string | null; runId?: string; now: number; maxAgeMs?: number }): string[] {
  const p: string[] = [];
  if (!want.sha || want.sha === "unknown") return ["the checkout sha is unknown: nothing can be bound to it"];
  if (!doc) return ["no signature: the evidence is unsigned"];
  if (!key) return ["no report signing key is configured (STRESS_REPORT_KEY_OP_REF): the evidence cannot be verified"];
  if (typeof doc !== "object" || typeof doc.hmac !== "string") return ["the signature is malformed"];
  const { hmac, ...meta } = doc;
  let okMac = false;
  try { okMac = timingSafeEqual(createHmac("sha256", key).update(canonical(meta as EvidenceMeta)).digest(), Buffer.from(hmac, "hex")); } catch { okMac = false; }
  if (!okMac) return ["the signature does not verify (edited, or signed with another key)"];
  if (doc.kind !== want.kind) p.push(`the evidence is a ${doc.kind}, not a ${want.kind}`);
  if (doc.sha === "unknown" || doc.sha !== want.sha) p.push(`the evidence is for commit ${doc.sha}, this checkout is ${want.sha}`);
  if (want.runId !== undefined && doc.runId !== want.runId) p.push(`the evidence is for run ${doc.runId}, not ${want.runId}`);
  const age = want.now - Date.parse(doc.at);
  if (!Number.isFinite(age) || age < 0 || age > (want.maxAgeMs ?? MAX_EVIDENCE_AGE_MS)) p.push("the evidence timestamp is unreadable, in the future, or older than the maximum age");
  if (want.kind === "stub_leg") {
    // The verdict and the run shape come from the SIGNED data.
    if (doc.verdict !== "PASS") p.push(`the signed verdict is ${doc.verdict ?? "absent"}, not PASS`);
    if (doc.profile !== "full" || doc.scope !== "full" || doc.fault !== "none") p.push(`the signed run is ${doc.profile}/${doc.scope}/${doc.fault}, not full/full/none`);
    if (typeof doc.appGuardPid !== "number" || !(doc.appGuardPid > 0)) p.push("the signed evidence records no app-guard pid");
  }
  if (want.subjectText === null) p.push("the evidence content is missing");
  else if (sha256(want.subjectText) !== doc.subjectSha256) p.push("the evidence content does not match what was signed (edited after signing)");
  return p;
}
