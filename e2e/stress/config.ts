import { execFileSync } from "node:child_process";

/**
 * Harness configuration. Everything is read from the environment once, validated here, and passed
 * down; no other module reads process.env for behaviour.
 *
 * DECISION SWITCHES. The plan's "Decisions needed" are NOT decided here. Each is a switch that
 * defaults to the safe/off choice. Flip one only when the named owner has decided.
 */
export type SendilloMode = "spot_check_human" | "autonomous_tagged_rows";
export type Scope = "full" | "replay";

export type DecisionSwitches = {
  /** Jarrad: approve the test SMS string `SANDRA TEST <run-id> <n> ignore` (spot check only). Default off. */
  testSmsStringApproved: boolean;
  /** Jarrad: Sendillo live leg. Default = human-confirmed spot check (the plan's chosen option). The autonomous option is not implemented here. */
  sendilloMode: SendilloMode;
  /** Jarrad: present (passive, desktop app open, cell on silent) for the Dialpad live leg. Default off = deferred. */
  dialpadLiveJarradPresent: boolean;
  /** Root: browser-capable execution context (Codex desktop) provided. Default off. */
  rootBrowserContextProvided: boolean;
  /** Root: candidate checkout carries #804 (merged or layered). Default off until confirmed. */
  rootCandidateCheckoutHasLaneGuard: boolean;
  /** Root: production Dialpad connection has NO active subscription for Jarrad's user, confirmed at run time. Default off = BLOCKED. */
  rootProdDialpadNoSubscriptionConfirmed: boolean;
};

export type StressConfig = {
  seed: number;
  runId: string;
  sha: string;
  scope: Scope;
  appUrl: string;
  /** What the browser/replay talk to. Equals appUrl unless the gate proxy is in front. */
  supabaseUrl: string;
  dbUrl: string;
  cronBase: string;
  cronSecret: string;
  webhookSecret: string;
  orgId: string;
  artifactsRoot: string;
  leadCount: number;
  stubPort: number;
  tickDeadlineMs: number;
  invariantIntervalMs: number;
  drainMaxMs: number;
  /** Fault injection for the harness self-test: none | duplicate_send | drop_offer | wrong_lead_note. */
  fault: FaultName;
  /** Absolute path of the egress log the APP UNDER TEST writes (its STRESS_EGRESS_LOG). Required at T0. */
  appEgressLog: string;
  decisions: DecisionSwitches;
  /** Every run is tagged; leads, notes and texts carry it. */
  runTag: string;
};

export type FaultName = "none" | "duplicate_send" | "drop_offer" | "wrong_lead_note";
export const FAULTS: readonly FaultName[] = ["none", "duplicate_send", "drop_offer", "wrong_lead_note"];

type Env = Readonly<Record<string, string | undefined>>;

const flag = (v: string | undefined) => v === "1" || v === "true";

export const DEFAULT_SEED = 20261005;
export const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000bbb";

export function readDecisions(env: Env): DecisionSwitches {
  const mode = env.STRESS_SENDILLO_MODE ?? "spot_check_human";
  if (mode !== "spot_check_human" && mode !== "autonomous_tagged_rows") throw new Error(`STRESS_SENDILLO_MODE must be spot_check_human or autonomous_tagged_rows, got ${mode}`);
  return {
    testSmsStringApproved: flag(env.STRESS_TEST_SMS_STRING_APPROVED),
    sendilloMode: mode,
    dialpadLiveJarradPresent: flag(env.STRESS_DIALPAD_LIVE_JARRAD_PRESENT),
    rootBrowserContextProvided: flag(env.STRESS_ROOT_BROWSER_CONTEXT),
    rootCandidateCheckoutHasLaneGuard: flag(env.STRESS_ROOT_CANDIDATE_HAS_LANE_GUARD),
    rootProdDialpadNoSubscriptionConfirmed: flag(env.STRESS_ROOT_PROD_DIALPAD_NO_SUBSCRIPTION),
  };
}

export type ConfigDeps = { headSha?: () => string };

/** The checkout identity. Never taken from a caller's environment: a retained STRESS_SHA would let another checkout reuse older PASS or self-test evidence. */
export function gitHeadSha(): string {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unknown"; }
}

export function readConfig(env: Env = process.env, deps: ConfigDeps = {}): StressConfig {
  const head = (deps.headSha ?? gitHeadSha)();
  if (env.STRESS_SHA && env.STRESS_SHA !== head) throw new Error(`STRESS_SHA (${env.STRESS_SHA}) does not match git HEAD (${head}); the sha is derived from the checkout, never from the environment.`);
  const seed = Number(env.CHAOS_SEED ?? DEFAULT_SEED);
  if (!Number.isInteger(seed)) throw new Error("CHAOS_SEED must be an integer");
  const fault = (env.STRESS_FAULT ?? "none") as FaultName;
  if (!FAULTS.includes(fault)) throw new Error(`STRESS_FAULT must be one of ${FAULTS.join(", ")}`);
  const scope = (env.STRESS_SCOPE ?? "full") as Scope;
  if (scope !== "full" && scope !== "replay") throw new Error("STRESS_SCOPE must be full or replay");
  const appUrl = (env.STRESS_APP_URL ?? "http://127.0.0.1:3456").replace(/\/$/, "");
  const runId = env.STRESS_RUN_ID ?? `s${seed}`;
  if (!/^[A-Za-z0-9-]{1,24}$/.test(runId)) throw new Error("STRESS_RUN_ID must be 1-24 chars of [A-Za-z0-9-]");
  return {
    seed,
    runId,
    sha: head,
    scope,
    appUrl,
    supabaseUrl: env.STRESS_SUPABASE_URL ?? env.TEST_SUPABASE_URL ?? "",
    dbUrl: env.E2E_CI_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL ?? "",
    cronBase: (env.STRESS_CRON_BASE ?? appUrl).replace(/\/$/, ""),
    cronSecret: env.E2E_CRON_SECRET ?? env.CRON_SECRET ?? "",
    webhookSecret: env.DIALPAD_CTI_WEBHOOK_SECRET_E2E ?? "",
    orgId: env.STRESS_ORG_ID ?? DEFAULT_ORG_ID,
    artifactsRoot: env.STRESS_ARTIFACTS_DIR ?? "artifacts",
    leadCount: Number(env.STRESS_LEADS ?? 70),
    stubPort: Number(env.STRESS_STUB_PORT ?? 0),
    tickDeadlineMs: Number(env.STRESS_TICK_DEADLINE_MS ?? 60_000),
    invariantIntervalMs: Number(env.STRESS_INVARIANT_INTERVAL_MS ?? 30_000),
    drainMaxMs: Number(env.STRESS_DRAIN_MAX_MS ?? 300_000),
    fault,
    appEgressLog: env.STRESS_APP_EGRESS_LOG ?? "",
    decisions: readDecisions(env),
    runTag: `STRESS-${runId}`,
  };
}

/** The ONLY text the harness may send to a real phone (live leg). Verbatim from the plan; never edited. */
export function approvedTestSms(runId: string, n: number): string {
  if (!/^[A-Za-z0-9-]{1,24}$/.test(runId)) throw new Error("bad run id");
  if (!Number.isInteger(n) || n < 1) throw new Error("bad n");
  return `SANDRA TEST ${runId} ${n} ignore`;
}
