import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { approvedTestSms, type StressConfig } from "./config";
import { isLoopbackUrl, LaneRefusal } from "./guards";

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
const defaultReadFile = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);

/** Resolves the owned numbers at run time. Nothing is persisted; the refs (never the values) are what the env carries. */
export function resolveOwnedNumbers(env: Env, deps: LiveDeps = {}): { cell: string; telnyx: string } {
  const opRead = deps.opRead ?? defaultOpRead;
  const read = (name: string) => {
    const ref = env[name];
    if (!ref) throw new Error(`${name} is not set`);
    const v = opRead(ref);
    if (!E164.test(v)) throw new Error(`${name} did not resolve to a +1XXXXXXXXXX number`);
    return v;
  };
  return { cell: read("STRESS_OP_REF_CELL"), telnyx: read("STRESS_OP_REF_TELNYX") };
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

export async function liveLegStatus(cfg: StressConfig, env: Env, deps: LiveDeps = {}): Promise<LiveStatus> {
  const readFile = deps.readFile ?? defaultReadFile;
  const p: Prerequisite[] = [];
  const add = (id: string, ok: boolean, detail: string) => p.push({ id, ok, detail });

  add("explicit_enable", env.STRESS_LIVE_LEG === "1", "STRESS_LIVE_LEG=1 (the live leg is off unless asked for by name)");

  // The stubbed leg must have passed, at THIS sha, as a full PASS (never a partial run).
  const reportPath = env.STRESS_STUB_LEG_REPORT ?? "";
  const report = reportPath ? readFile(reportPath) : null;
  const passLine = report ? /^# Chaos day [^:]+: PASS\s*$/m.test(report) : false;
  const shaOk = report ? new RegExp(`^- SHA: ${cfg.sha}\\s*$`, "m").test(report) && cfg.sha !== "unknown" : false;
  const fullOk = report ? /^- Profile: full, scope: full, fault: none\s*$/m.test(report) : false;
  add("stubbed_leg_passed_at_this_sha", passLine && shaOk && fullOk, report ? `report ${passLine ? "is PASS" : "is not PASS"}, sha ${shaOk ? "matches" : "does not match"}, profile/scope ${fullOk ? "full" : "not full/full/no-fault"}` : "STRESS_STUB_LEG_REPORT is not set or unreadable");

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
