import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";
import { assertLaneSafe } from "../support/my-leads-close-fixture";
import type { StressConfig } from "./config";

/**
 * Lane guards. Every one runs BEFORE any connection (database, HTTP, stub, browser). Fail closed:
 * anything unproven is a refusal, and a refusal is a FAIL, never a skip.
 *
 * Reuses #804's `assertLaneSafe('ci')` (E2E_DISPOSABLE_DATABASE=1 + loopback DB URL) and adds the
 * stress-specific rails: opt-in, loopback for every binding, production-ref scan, live-leg off.
 */

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/** Hosted Supabase project refs (test + prod) the repo knows about; none may appear anywhere in the environment. */
const HOSTED_REFS = /ncsngxlcyxylaeskiteu|copflsklaefwzipsrjqz|\.supabase\.co\b|\.supabase\.in\b/i;
/** Env keys whose URL values must be loopback. */
const URL_KEY = /^(STRESS_.*(URL|BASE)|TEST_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_URL|SUPABASE_URL|DATABASE_URL|POSTGRES_URL.*|E2E_CI_SUPABASE_DB_URL|TEST_SUPABASE_DB_URL|HEAVY_UPSTREAM_.*)$/;

/** Ports of the long-running dev stacks (mirrors provision-stack.mjs, which refuses to create a stack on them). Any binding on one of these is refused. */
export const DEV_STACK_PORTS: readonly number[] = [54321, 54322, 54329, 54331];
export function devStackPortIn(url: string): number | null {
  try { const u = new URL(url.replace(/^postgres(ql)?:/, "http:")); const port = Number(u.port || 0); return DEV_STACK_PORTS.includes(port) ? port : null; } catch { return null; }
}

export class LaneRefusal extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "LaneRefusal";
  }
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "postgres:" || u.protocol === "postgresql:") && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export function hostPort(raw: string): string {
  const u = new URL(raw);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return `${u.hostname.replace(/^\[|\]$/g, "")}:${port}`;
}

/** Throws LaneRefusal unless the whole environment is a disposable local stack and the harness was explicitly opted into. */
export function assertStressLane(cfg: StressConfig, env: Env = process.env, opts: { live?: boolean } = {}): void {
  const live = opts.live === true;
  if (env.STRESS_HARNESS !== "1") throw new LaneRefusal("NOT_OPTED_IN", "set STRESS_HARNESS=1 (this harness is opt-in and never part of default CI).");
  if (env.VERCEL_ENV || env.VERCEL === "1") throw new LaneRefusal("HOSTED_RUNTIME", "refusing to run on a hosted runtime.");
  if (env.RUN_PROD_CANARIES === "1") throw new LaneRefusal("PROD_CANARY_FLAG", "RUN_PROD_CANARIES is set; this is not a production lane.");
  if (live) {
    if (env.STRESS_LIVE_LEG !== "1") throw new LaneRefusal("LIVE_LEG_NOT_ENABLED", "the live lane needs STRESS_LIVE_LEG=1.");
    if (env.CI || env.GITHUB_ACTIONS) throw new LaneRefusal("LIVE_LEG_IN_CI", "the live leg never runs in CI.");
  } else if (env.STRESS_LIVE_LEG === "1") throw new LaneRefusal("LIVE_LEG_IN_STUB_RUN", "STRESS_LIVE_LEG=1 must not be set for the stubbed leg; the live leg is a separate, gated entrypoint.");

  for (const [key, value] of Object.entries(env)) {
    if (value && HOSTED_REFS.test(value)) throw new LaneRefusal("HOSTED_REF_IN_ENV", `${key} references a hosted Supabase project.`);
    if (live && key === "STRESS_TUNNEL_URL") continue; // the live leg's ONLY non-loopback endpoint (Dialpad webhook ingress), validated by liveLegStatus
    if (value && URL_KEY.test(key) && /^[a-z]+:\/\//i.test(value) && !isLoopbackUrl(value)) {
      throw new LaneRefusal("NON_LOOPBACK_ENV", `${key} is not a loopback URL.`);
    }
  }

  // #804's lane guard: E2E_DISPOSABLE_DATABASE=1 plus a loopback E2E_CI_SUPABASE_DB_URL/TEST_SUPABASE_DB_URL.
  try {
    assertLaneSafe("ci", env);
  } catch (e) {
    throw new LaneRefusal("LANE_UNSAFE", (e as Error).message);
  }
  if (env.E2E_DISPOSABLE_DATABASE !== "1") throw new LaneRefusal("NOT_DISPOSABLE", "E2E_DISPOSABLE_DATABASE must be exactly 1.");
  if (!cfg.dbUrl) throw new LaneRefusal("NO_DB_URL", "E2E_CI_SUPABASE_DB_URL is required.");
  try {
    requireLoopbackPostgresUrl(cfg.dbUrl);
  } catch {
    throw new LaneRefusal("DB_NOT_LOOPBACK", "database URL is not a plain loopback postgres URL.");
  }

  for (const [name, url] of [["database URL", cfg.dbUrl], ["supabase URL", cfg.supabaseUrl]] as const) {
    const port = devStackPortIn(url);
    if (port !== null) throw new LaneRefusal("DEV_STACK_PORT", `${name} uses port ${port}, a dev-stack port: refusing (provision a throwaway stack with e2e/stress/provision-stack.mjs).`);
  }
  for (const [name, url] of [["app URL", cfg.appUrl], ["supabase URL", cfg.supabaseUrl], ["cron base", cfg.cronBase]] as const) {
    if (!url) throw new LaneRefusal("MISSING_BINDING", `${name} is not set.`);
    if (!isLoopbackUrl(url)) throw new LaneRefusal("BINDING_NOT_LOOPBACK", `${name} is not loopback.`);
  }
  // Cron target must be the app under test (same stack), never another host.
  if (hostPort(cfg.cronBase) !== hostPort(cfg.appUrl)) throw new LaneRefusal("CRON_TARGET_MISMATCH", "cron base must resolve to the same host:port as the app URL.");
  // The DB URL and the Supabase API URL are two ports of one local stack; they must not be the same port.
  if (hostPort(cfg.dbUrl.replace(/^postgres(ql)?:/, "http:")) === hostPort(cfg.supabaseUrl)) throw new LaneRefusal("BINDING_CONFUSION", "db and api URLs resolve to the same host:port.");
  if (!cfg.cronSecret) throw new LaneRefusal("NO_CRON_SECRET", "E2E_CRON_SECRET (or CRON_SECRET) is required to drive the cron routes.");
  if (!cfg.webhookSecret) throw new LaneRefusal("NO_WEBHOOK_SECRET", "DIALPAD_CTI_WEBHOOK_SECRET_E2E is required to sign Dialpad events.");
  if (!cfg.decisions.rootCandidateCheckoutHasLaneGuard) {
    // Informational in code (assertLaneSafe is imported above, so the checkout carries it), but the root decision is recorded in the report.
  }
}

/** The live lane: everything the stubbed lane requires (loopback bindings, disposable DB, no hosted refs) plus the explicit opt-in, no CI, and BOTH Supabase URLs present and loopback. */
export function assertLiveLane(cfg: StressConfig, env: Env = process.env): void {
  assertStressLane(cfg, env, { live: true });
  for (const k of ["TEST_SUPABASE_URL", "STRESS_SUPABASE_URL"]) {
    const v = env[k];
    if (!v || !isLoopbackUrl(v)) throw new LaneRefusal("NON_LOOPBACK_ENV", `${k} must be set to a loopback URL for the live leg.`);
  }
}

/** Refuses a database holding anything but harness leads BEFORE the tenant tables are wiped (a wipe of someone else's data must never be the first step). */
export function assertOnlyHarnessData(counts: { properties: number; nonHarnessProperties: number }): void {
  if (counts.nonHarnessProperties > 0) throw new LaneRefusal("DB_HAS_FOREIGN_DATA", `${counts.nonHarnessProperties} of ${counts.properties} properties are not harness leads (address STRESS-*): refusing to reset this database.`);
}

/** Proof, after the DB connects, that the database is fresh: no properties outside this run's tag. */
export function assertFreshCounts(counts: { properties: number; untaggedProperties: number }, runTag: string): void {
  if (counts.untaggedProperties > 0) {
    throw new LaneRefusal("DB_NOT_FRESH", `${counts.untaggedProperties} properties exist that are not tagged ${runTag}; refusing to run against a database with other data.`);
  }
}
