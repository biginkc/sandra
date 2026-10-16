import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { approvedTestSms, type StressConfig } from "./config";
import { isLoopbackUrl, LaneRefusal } from "./guards";
import { evidenceProblems, loadReportKey, numberPin, type SignedEvidence } from "./signing";
import { selfTestReportOk } from "./selftest-spec";

/**
 * LIVE LEG (owned numbers only). WRITTEN BUT DISABLED. It refuses to start unless EVERY prerequisite
 * below is met, and it never contains a provider call of its own: calls leave only through the real
 * app UI of an isolated Sandra instance (see browser/live-leg.spec.ts), never from this module.
 *
 * Enabled only by STRESS_LIVE_LEG=1 together with every prerequisite. The stubbed leg's lane guard
 * (guards.ts) refuses STRESS_LIVE_LEG=1, so the two can never run in one process by accident.
 *
 * Scope per the plan (section 9):
 *   - Dialpad live calls: ~8 calls, 3-5 minutes apart, owned numbers only.
 *   - Sendillo: NOT autonomous. Decision taken in the plan: a human-confirmed spot check, one approved
 *     string from the Sendillo number to Jarrad's cell. This module prints the exact string and the
 *     read-only verification query; it does not send anything and does not touch production.
 *   - Telnyx is a ring target only; it is not exercised as a provider.
 * The ONLY text that may reach a real phone: `SANDRA TEST <run-id> <n> ignore` (config.approvedTestSms).
 */

export type Prerequisite = { id: string; ok: boolean; detail: string };
export type LiveStatus = { ready: boolean; prerequisites: Prerequisite[] };

type Env = Readonly<Record<string, string | undefined>>;
export type LiveDeps = {
  /** Pinned sha256 allowlists of the owned numbers (default: owned-numbers.sha256.json). Injected in tests. */
  pinned?: { cell: readonly string[]; telnyx: readonly string[] };
  /** Wall clock (ms) for evidence age. */
  now?: () => number;
  /** Report signing key loader (default: loadReportKey over env). */
  reportKey?: () => string | null;
  /** Reads a secret reference (op://...). Default: the 1Password CLI with the service account. Injected in tests. */
  opRead?: (ref: string) => string;
  readFile?: (path: string) => string | null;
};

const E164 = /^\+1\d{10}$/;
const mask = (n: string) => `+1******${n.slice(-2)}`;

function defaultOpRead(ref: string): string {
  if (!/^op:\/\/[^\s]+$/.test(ref)) throw new Error("not an op:// reference");
  // execFile with an argument vector: no shell, nothing echoed. The value is returned to the caller only.
  return execFileSync("op", ["read", "--no-newline", ref], { encoding: "utf8", timeout: 20_000 }).trim();
}
export function loadPinnedHashes(file = path.resolve(__dirname, "owned-numbers.sha256.json")): { cell: string[]; telnyx: string[] } {
  const j = JSON.parse(readFileSync(file, "utf8")) as { cell?: unknown; telnyx?: unknown };
  const clean = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[0-9a-f]{64}$/.test(x)) : []);
  return { cell: clean(j.cell), telnyx: clean(j.telnyx) };
}
const defaultReadFile = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);

/** Resolves the owned numbers at run time. Nothing is persisted; the refs (never the values) are what the env carries. */
export function resolveOwnedNumbers(env: Env, deps: LiveDeps = {}): { cell: string; telnyx: string } {
  // The default reader shells out to `op`: only in service-account mode (a desktop session would silently use the personal account).
  if (!deps.opRead && !env.OP_SERVICE_ACCOUNT_TOKEN) throw new Error("OP_SERVICE_ACCOUNT_TOKEN is not set: refusing to run `op read` (BMH service account only)");
  const opRead = deps.opRead ?? defaultOpRead;
  const read = (name: string) => {
    const ref = env[name];
    if (!ref) throw new Error(`${name} is not set`);
    const v = opRead(ref);
    if (!E164.test(v)) throw new Error(`${name} did not resolve to a +1XXXXXXXXXX number`);
    return v;
  };
  const numbers = { cell: read("STRESS_OP_REF_CELL"), telnyx: read("STRESS_OP_REF_TELNYX") };
  // Pinned allowlist: only a number whose HMAC (under the report key, kept outside the repo) is committed may ever be dialled. Empty or missing pin = refuse.
  const pinned = deps.pinned ?? loadPinnedHashes();
  const key = (deps.reportKey ?? (() => loadReportKey(env)))();
  if (!key) throw new Error("no report signing key (STRESS_REPORT_KEY_OP_REF): the number pins are HMACs under it");
  for (const role of ["cell", "telnyx"] as const) {
    if (pinned[role].length === 0) throw new Error(`no pinned HMAC for the owned ${role} number: pin it with \`npm run stress -- pin-number ${role}\` and commit the value`);
    if (!pinned[role].includes(numberPin(numbers[role], key))) throw new Error(`the ${role} number resolved from op is not on the pinned allowlist (HMAC mismatch): refusing to dial it`);
  }
  return numbers;
}

/**
 * Re-run immediately before EVERY click: the phone the seeded lead holds right now must still be the pinned owned number for this step's target,
 * so a lead edited, swapped or re-seeded between the start of the leg and the click can never ring anyone else.
 */
export function pinnedPhoneProblems(phoneNow: string | null, role: "cell" | "telnyx", pinned: { cell: readonly string[]; telnyx: readonly string[] }, key: string | null): string[] {
  if (!key) return ["no report signing key: the number pin cannot be checked"];
  if (!phoneNow || !E164.test(phoneNow)) return [`the lead's current phone is not a +1XXXXXXXXXX number`];
  if (pinned[role].length === 0) return [`no pinned HMAC for the owned ${role} number`];
  return pinned[role].includes(numberPin(phoneNow, key)) ? [] : [`the lead's current phone is not the pinned owned ${role} number: refusing to click Call`];
}

export type LiveCallShape = "ring_timeout_telnyx" | "voicemail_cell" | "cancel_before_answer" | "double_dial_refused";
export type LiveCallStep = { n: number; shape: LiveCallShape; target: "cell" | "telnyx"; gapMs: number; expectRefusal?: boolean };

/** The ~8 live Dialpad calls. Shapes need no pickup. `double_dial_refused` is a pair: the second dial inside 20 s MUST be refused by the intent rule. */
export function liveCallPlan(): LiveCallStep[] {
  const gap = 4 * 60_000; // 3-5 minutes between calls (Dialpad allows 5/min per user; the app's own guard is 4/min)
  return [
    { n: 1, shape: "ring_timeout_telnyx", target: "telnyx", gapMs: gap },
    { n: 2, shape: "ring_timeout_telnyx", target: "telnyx", gapMs: gap },
    { n: 3, shape: "voicemail_cell", target: "cell", gapMs: gap },
    { n: 4, shape: "voicemail_cell", target: "cell", gapMs: gap },
    { n: 5, shape: "cancel_before_answer", target: "telnyx", gapMs: gap },
    { n: 6, shape: "cancel_before_answer", target: "cell", gapMs: gap },
    { n: 7, shape: "double_dial_refused", target: "telnyx", gapMs: gap },
    { n: 8, shape: "double_dial_refused", target: "telnyx", gapMs: 20_000, expectRefusal: true },
  ];
}

/**
 * What the click on Call did, judged ONLY on affirmative evidence. "No new authorization appeared" is not a refusal: an internal error, a 5xx, a dead
 * page or a silent UI also produce no new intent. A refusal is proven only when the UI shows the intent rule's own message (`call_in_flight`: "A call is
 * already being placed...", or `prior_call_unresolved`: "...never confirmed. It may have rung...") and no 5xx/server-error evidence exists.
 */
export const INTENT_RULE_REFUSALS: readonly RegExp[] = [/A call is already being placed\. Wait for Dialpad to confirm it\./i, /Your last call to this lead was never confirmed\. It may have rung\./i];
const ERROR_SIGNS: readonly RegExp[] = [/Something went wrong/i, /internal server error/i, /could not confirm the call/i, /\b5\d\d\b/];
export type DialObservation = { newAuthorizedIntents: number; statusText: string | null; httpStatuses: number[]; intentRefusalRows?: number };
export type DialJudgement = { refused: boolean; ok: boolean; note: string };
export function judgeDialRefusal(o: DialObservation): DialJudgement {
  const text = (o.statusText ?? "").replace(/\s+/g, " ").trim();
  const serverError = o.httpStatuses.find((s) => s >= 500);
  if (serverError !== undefined) return { refused: false, ok: false, note: `violation: a ${serverError} came back from the dial action` };
  if (ERROR_SIGNS.some((r) => r.test(text))) return { refused: false, ok: false, note: `violation: the UI shows an error, not the intended refusal (${text.slice(0, 100)})` };
  if (o.newAuthorizedIntents > 0) return { refused: false, ok: true, note: "the dial was authorized (not refused)" };
  if (INTENT_RULE_REFUSALS.some((r) => r.test(text)) || (o.intentRefusalRows ?? 0) > 0) return { refused: true, ok: true, note: text.slice(0, 160) || "intent-rule refusal row recorded" };
  return { refused: false, ok: false, note: `no affirmative evidence of the intended refusal (no new authorization, but the UI said: ${text.slice(0, 100) || "nothing"})` };
}

export type LiveEvidence = { callId: string | null; terminalState: string | null; cause: string | null; attemptMatched: boolean; refused?: boolean };
/** Anything without a Dialpad call id AND a terminal event AND a matched attempt is "unverified", never a pass. A required refusal needs only the refusal. */
export function classifyLiveEvidence(step: LiveCallStep, e: LiveEvidence): "verified" | "unverified" {
  if (step.expectRefusal) return e.refused === true ? "verified" : "unverified";
  return e.callId && e.terminalState && e.cause && e.attemptMatched ? "verified" : "unverified";
}

/** The exact text for the human-confirmed Sendillo spot check, and the read-only check Jarrad/root runs afterwards. */
export function sendilloSpotCheck(runId: string): { text: string; readOnlyVerification: string } {
  return {
    text: approvedTestSms(runId, 1),
    readOnlyVerification: "READ-ONLY, production: select event_type, created_at from public.webhook_events where payload::text like '%' || <message id from the send> || '%' order by created_at; (no insert/update/delete; Jarrad confirms receipt on his cell)",
  };
}

/**
 * The live app's build identity, bound to the harness checkout: the app is started with the guard in `STRESS_GUARD_MODE=announce` (it denies
 * nothing and diverts nothing, so real providers stay reachable) and `STRESS_EGRESS_LOG=<STRESS_LIVE_APP_IDENTITY_LOG>`; the line written by the
 * listener's own pid must name this exact commit with no tracked changes. A retained or foreign sha cannot satisfy it.
 */
export function liveAppIdentityProblems(lines: string[], listenerPid: number | null, sha: string, logPath: string): string[] {
  if (listenerPid == null) return ["no process is listening on the app port"];
  let g: { kind?: string; pid?: number; sha?: string | null; dirty?: boolean; log?: string; redirect?: string | null } | null = null;
  for (const l of lines) { try { const j = JSON.parse(l); if (j.kind === "guard_loaded" && j.pid === listenerPid) g = j; } catch { /* skip */ } }
  if (!g) return [`no guard_loaded line from pid ${listenerPid} in ${logPath}: start the live app with the guard in STRESS_GUARD_MODE=announce`];
  const p: string[] = [];
  if (g.log !== logPath) p.push(`the app's identity line is logged to ${g.log ?? "unknown"}, not ${logPath}`);
  if (!g.sha || g.sha !== sha || sha === "unknown") p.push(`the live app runs commit ${g.sha ?? "unknown"}, the harness checkout is ${sha}`);
  if (g.dirty !== false) p.push("the live app's checkout has uncommitted tracked changes");
  if (g.redirect) p.push("the live app has a Dialpad redirect installed (announce mode only)");
  return p;
}

/**
 * The identity check re-run before EVERY dial: the listener on the app port is still the announce-mode app of this commit (pid, sha, clean tree, line in
 * the right log), its guard line POSTDATES the process start (not a stale line from an earlier process), it runs as the harness uid, and its checkout
 * holds no .env* Next would load.
 */
export function liveAppRecheckProblems(f: { pid: number | null; uid: number | null; startMs: number | null; lines: string[]; envFiles: string[] }, sha: string, logPath: string, harnessUid: number): string[] {
  const p = liveAppIdentityProblems(f.lines, f.pid, sha, logPath);
  if (f.pid == null) return p;
  if (f.uid == null || f.uid !== harnessUid) p.push(`the live app runs as uid ${f.uid ?? "unknown"}, the harness as ${harnessUid}`);
  let at: string | undefined;
  for (const l of f.lines) { try { const j = JSON.parse(l); if (j.kind === "guard_loaded" && j.pid === f.pid) at = j.at; } catch { /* skip */ } }
  if (f.startMs == null || at === undefined || !(Date.parse(at) >= f.startMs - 2000)) p.push("the guard line does not postdate the listener's start (stale line, or unknown start time)");
  if (f.envFiles.length) p.push(`the live app's checkout has ${f.envFiles.join(", ")} (Next would load them)`);
  return p;
}

export async function liveLegStatus(cfg: StressConfig, env: Env, deps: LiveDeps = {}): Promise<LiveStatus> {
  const readFile = deps.readFile ?? defaultReadFile;
  const p: Prerequisite[] = [];
  const add = (id: string, ok: boolean, detail: string) => p.push({ id, ok, detail });

  add("explicit_enable", env.STRESS_LIVE_LEG === "1", "STRESS_LIVE_LEG=1 (the live leg is off unless asked for by name)");
  // Never in CI or a hosted runtime, whatever else is set.
  add("not_ci", !env.CI && !env.GITHUB_ACTIONS && !env.VERCEL && !env.VERCEL_ENV, "not running in CI or a hosted runtime (CI, GITHUB_ACTIONS, VERCEL, VERCEL_ENV must be unset)");

  // Evidence is SIGNED by the engine (key outside the repo), run-bound and fresh; sha "unknown" is refused everywhere.
  const now = (deps.now ?? Date.now)();
  let key: string | null = null;
  let keyError: string | null = null;
  try { key = (deps.reportKey ?? (() => loadReportKey(env)))(); } catch (e) { keyError = (e as Error).message; }
  add("report_signing_key", !!key, key ? "report signing key loaded (outside the repo)" : keyError ?? "no report signing key configured (STRESS_REPORT_KEY_OP_REF)");

  // The stubbed leg must have passed, at THIS sha, as a full PASS (never a partial run).
  const reportPath = env.STRESS_STUB_LEG_REPORT ?? "";
  const report = reportPath ? readFile(reportPath) : null;
  const sigText = reportPath ? readFile(path.join(path.dirname(reportPath), "REPORT.sig.json")) : null;
  let sig: SignedEvidence | null = null;
  try { sig = sigText ? (JSON.parse(sigText) as SignedEvidence) : null; } catch { sig = null; }
  const wantRun = env.STRESS_STUB_LEG_RUN_ID ?? "";
  const sigProblems = evidenceProblems(sig, key, { kind: "stub_leg", sha: cfg.sha, subjectText: report, runId: wantRun || "<STRESS_STUB_LEG_RUN_ID not set>", now });
  // Verdict, profile/scope/fault, sha and the app-guard pid are read from the SIGNED payload (evidenceProblems), never from a regex over the report text:
  // a FAIL report can quote "# Chaos day X: PASS" in its reasons.
  add("stubbed_leg_passed_at_this_sha", report !== null && sig !== null && sig.verdict === "PASS" && sig.sha === cfg.sha && cfg.sha !== "unknown" && sig.profile === "full" && sig.scope === "full" && sig.fault === "none", sig ? `signed verdict ${sig.verdict}, sha ${sig.sha === cfg.sha ? "matches" : "does not match"}, run ${sig.profile}/${sig.scope}/${sig.fault}` : "no signed evidence");
  add("stubbed_leg_signed_run_bound_fresh", report !== null && sigProblems.length === 0, report ? (sigProblems.join("; ") || "signed, run-bound, fresh") : "no report");
  add("stubbed_leg_app_guard_proven", sig !== null && typeof sig.appGuardPid === "number" && sig.appGuardPid > 0, sig ? `signed evidence ${typeof sig.appGuardPid === "number" ? "records" : "does not record"} the guard proven inside the app (pid)` : "no signed evidence");
  // And a passing self-test at this sha (the harness must be shown able to fail), signed the same way.
  const stText = env.STRESS_SELFTEST_REPORT ? readFile(env.STRESS_SELFTEST_REPORT) : null;
  let stOk = false;
  let stDetail = stText ? "self-test report is not a pass at this sha" : "STRESS_SELFTEST_REPORT is not set or unreadable";
  try {
    const st = stText ? (JSON.parse(stText) as { sha?: string; ok?: boolean; rows?: unknown[]; sig?: SignedEvidence }) : null;
    const problems = st ? evidenceProblems(st.sig ?? null, key, { kind: "selftest", sha: cfg.sha, subjectText: JSON.stringify({ sha: st.sha, ok: st.ok, rows: st.rows }), now }) : ["no self-test report"];
    stOk = !!st && problems.length === 0 && selfTestReportOk(st as never, cfg.sha);
    if (st && problems.length) stDetail = problems.join("; ");
    else if (stOk) stDetail = "self-test report is signed, fresh, ok at this sha with every fault fired and caught";
  } catch { stOk = false; }
  add("selftest_passed_at_this_sha", stOk, stDetail);

  add("live_app_identity_log", !!env.STRESS_LIVE_APP_IDENTITY_LOG && env.STRESS_LIVE_APP_IDENTITY_LOG.startsWith("/"), "STRESS_LIVE_APP_IDENTITY_LOG (absolute path) is where the live app's announce-mode guard writes its build identity");

  // Decisions that belong to people (all default off).
  add("decision_sms_string_approved", cfg.decisions.testSmsStringApproved, "Jarrad approved the string `SANDRA TEST <run-id> <n> ignore` (STRESS_TEST_SMS_STRING_APPROVED=1)");
  add("decision_sendillo_mode_spot_check", cfg.decisions.sendilloMode === "spot_check_human", "Sendillo stays a human-confirmed spot check; the autonomous mode is not built");
  add("decision_jarrad_present", cfg.decisions.dialpadLiveJarradPresent, "Jarrad present (passive, desktop app open, cell on silent) (STRESS_DIALPAD_LIVE_JARRAD_PRESENT=1)");
  add("decision_root_browser_context", cfg.decisions.rootBrowserContextProvided, "root provides the browser-capable context (STRESS_ROOT_BROWSER_CONTEXT=1)");
  add("decision_root_prod_dialpad_unsubscribed", cfg.decisions.rootProdDialpadNoSubscriptionConfirmed, "root confirmed production's Dialpad connection has NO active subscription for Jarrad's user at run time (else events would also project into production: BLOCKED)");
  add("jarrad_desktop_app_running", env.STRESS_DIALPAD_DESKTOP_CONFIRMED === "1", "Jarrad's Dialpad desktop app is running (API dial rings his device first)");

  // Isolated instance: loopback app + disposable local DB; only the Dialpad webhook ingress may be a tunnel.
  add("isolated_instance_loopback", isLoopbackUrl(cfg.appUrl) && env.E2E_DISPOSABLE_DATABASE === "1" && isLoopbackUrl(cfg.dbUrl.replace(/^postgres(ql)?:/, "http:")), "candidate build on loopback with a disposable local database");
  const tunnel = env.STRESS_TUNNEL_URL ?? "";
  add("tunnel_url_https", /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(tunnel) && !isLoopbackUrl(tunnel), "STRESS_TUNNEL_URL (https) is the ONLY non-loopback endpoint, used for Dialpad webhook ingress");
  const proof = env.STRESS_DIALPAD_SUBSCRIPTION_PROOF ? readFile(env.STRESS_DIALPAD_SUBSCRIPTION_PROOF) : null;
  add("dialpad_subscription_proof", !!proof && !!tunnel && proof.includes(tunnel), "provision-dialpad-cti proof file lists a webhook subscription for the tunnel URL of this isolated instance");

  // Owned numbers resolve at run time through the op CLI; only the allowlist of two may ever be dialled.
  let numbersOk = false;
  let numbersDetail = "";
  try {
    const n = resolveOwnedNumbers(env, deps);
    numbersOk = n.cell !== n.telnyx;
    numbersDetail = numbersOk ? `cell ${mask(n.cell)}, telnyx ${mask(n.telnyx)} resolved via op` : "cell and telnyx resolved to the same number";
  } catch (e) {
    numbersDetail = (e as Error).message;
  }
  add("owned_numbers_via_op", numbersOk, numbersDetail);

  // The isolated instance's world (org + rep) written by its provisioning; the driver only reads it.
  let worldOk = false;
  try { const w = env.STRESS_LIVE_WORLD_FILE ? readFile(env.STRESS_LIVE_WORLD_FILE) : null; const j = w ? JSON.parse(w) as { orgId?: string; repUserId?: string } : null; worldOk = !!j?.orgId && !!j?.repUserId; } catch { worldOk = false; }
  add("live_world_file", worldOk, "STRESS_LIVE_WORLD_FILE names a JSON file with { orgId, repUserId } for the rep of the isolated instance");

  // The kill switch (KILL file + `stress kill`) needs an explicit artifacts directory to watch.
  add("kill_switch_armed", !!env.STRESS_ARTIFACTS_DIR, "STRESS_ARTIFACTS_DIR is set so the KILL file and kill-switch evidence have a home");

  return { ready: p.every((x) => x.ok), prerequisites: p };
}

/** Throws unless every prerequisite is met. The only entry that may start live traffic; it still starts none itself. */
export async function assertLiveLegReady(cfg: StressConfig, env: Env, deps: LiveDeps = {}): Promise<{ numbers: { cell: string; telnyx: string }; plan: LiveCallStep[] }> {
  const s = await liveLegStatus(cfg, env, deps);
  const unmet = s.prerequisites.filter((x) => !x.ok);
  if (unmet.length > 0) throw new LaneRefusal("LIVE_LEG_PREREQUISITES_UNMET", unmet.map((u) => `${u.id}: ${u.detail}`).join(" | "));
  return { numbers: resolveOwnedNumbers(env, deps), plan: liveCallPlan() };
}
