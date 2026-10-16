import { requireLoopbackPostgresUrl } from "./loopback-postgres-url";

/**
 * Isolation guard for destructive DB integration suites.
 *
 * These suites seed, mutate and delete rows. They must only ever run against a
 * stack the caller owns and can throw away. This guard runs from a vitest
 * globalSetup, i.e. before any test file loads and before any connection.
 *
 * Rules:
 *  - every required value is set explicitly (no silent defaults);
 *  - URLs are loopback, carry no query/hash, and never name a hosted Supabase host;
 *  - the long-running shared dev ports (54321, 54322, 54329, 54331) are refused;
 *  - TEST_* and LOCAL_* name the same stack (same URL and service-role key).
 *
 * CI exception (narrow): GitHub's disposable per-job stack
 * (scripts/provision-e2e-local-database.mjs) binds the CLI defaults 54321/54322.
 * Those two ports are allowed only when CI is truthy, GITHUB_ACTIONS=true and
 * E2E_DISPOSABLE_DATABASE=1 (published by that provisioning script).
 */

export const SHARED_DEV_PORTS = ["54321", "54322", "54329", "54331"] as const;
const CI_DISPOSABLE_PORTS = ["54321", "54322"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const HOSTED = /supabase\.(co|com)(?![a-z0-9])/i;

export const API_KEYS = [
  "LOCAL_SUPABASE_URL",
  "LOCAL_SUPABASE_SERVICE_ROLE_KEY",
  "TEST_SUPABASE_URL",
  "TEST_SUPABASE_SERVICE_ROLE_KEY",
  "TEST_SUPABASE_DB_URL",
] as const;

type Env = Readonly<Record<string, string | undefined>>;

export class IsolatedDbEnvError extends Error {
  constructor(message: string) {
    super(`[isolated-db-env] ${message} See tests/integration/README.md ("Run against your own stack").`);
    this.name = "IsolatedDbEnvError";
  }
}

function isCiDisposable(env: Env): boolean {
  const ci = (env.CI ?? "").toLowerCase();
  return (ci === "1" || ci === "true") && env.GITHUB_ACTIONS === "true" && env.E2E_DISPOSABLE_DATABASE === "1";
}

function portOf(u: URL): string {
  if (u.port) return u.port;
  if (u.protocol === "postgres:" || u.protocol === "postgresql:") return "5432";
  return u.protocol === "https:" ? "443" : "80";
}

function checkUrl(key: string, value: string, env: Env): string {
  if (HOSTED.test(value)) throw new IsolatedDbEnvError(`${key} names a hosted Supabase host; refusing.`);
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new IsolatedDbEnvError(`${key} is not a valid URL.`);
  }
  if (!LOOPBACK.has(u.hostname)) throw new IsolatedDbEnvError(`${key} is not a loopback host (${u.hostname}).`);
  if (u.search || u.hash) throw new IsolatedDbEnvError(`${key} must not carry a query string or hash.`);
  const port = portOf(u);
  if ((SHARED_DEV_PORTS as readonly string[]).includes(port)) {
    if (!(isCiDisposable(env) && CI_DISPOSABLE_PORTS.includes(port))) {
      throw new IsolatedDbEnvError(
        `${key} uses port ${port}, a shared dev-stack port (54321/54322/54329/54331). Start your own stack on other ports and point the env there.`,
      );
    }
  }
  return port;
}

function requireSet(env: Env, key: string): string {
  const value = env[key];
  if (!value || value.trim() === "") throw new IsolatedDbEnvError(`${key} must be set explicitly (no defaults).`);
  return value;
}

/** DB-only suites (raw Postgres, no API). */
export function assertIsolatedDbUrl(env: Env, key = "TEST_SUPABASE_DB_URL"): void {
  const db = requireSet(env, key);
  checkUrl(key, db, env);
  try {
    requireLoopbackPostgresUrl(db);
  } catch {
    throw new IsolatedDbEnvError(`${key} is not a loopback postgres URL.`);
  }
}

/**
 * Norma stress gate: clones schema from NORMA_STRESS_SOURCE_DB_URL (falling back
 * to TEST_SUPABASE_DB_URL). One of them must be set; every one that is set is checked.
 */
export function assertIsolatedNormaStressEnv(env: Env): void {
  const keys = ["NORMA_STRESS_SOURCE_DB_URL", "TEST_SUPABASE_DB_URL"].filter((k) => (env[k] ?? "").trim() !== "");
  if (keys.length === 0) throw new IsolatedDbEnvError("NORMA_STRESS_SOURCE_DB_URL (or TEST_SUPABASE_DB_URL) must be set explicitly (no defaults).");
  for (const key of keys) assertIsolatedDbUrl(env, key);
}

/** Slack local suites read SLACK_LOCAL_* and map them onto TEST_SUPABASE_*. */
export function assertIsolatedSlackLocalEnv(env: Env): void {
  for (const key of ["SLACK_LOCAL_API_URL", "SLACK_LOCAL_SERVICE_KEY", "SLACK_LOCAL_DB_URL"]) requireSet(env, key);
  assertIsolatedDbEnv({
    ...env,
    LOCAL_SUPABASE_URL: env.SLACK_LOCAL_API_URL,
    TEST_SUPABASE_URL: env.SLACK_LOCAL_API_URL,
    LOCAL_SUPABASE_SERVICE_ROLE_KEY: env.SLACK_LOCAL_SERVICE_KEY,
    TEST_SUPABASE_SERVICE_ROLE_KEY: env.SLACK_LOCAL_SERVICE_KEY,
    TEST_SUPABASE_DB_URL: env.SLACK_LOCAL_DB_URL,
  });
}

/** Suites that use both the API (service role) and Postgres. */
export function assertIsolatedDbEnv(env: Env): void {
  for (const key of API_KEYS) requireSet(env, key);
  if (env.TEST_SUPABASE_URL !== env.LOCAL_SUPABASE_URL) {
    throw new IsolatedDbEnvError("TEST_SUPABASE_URL and LOCAL_SUPABASE_URL must be the same stack.");
  }
  if (env.TEST_SUPABASE_SERVICE_ROLE_KEY !== env.LOCAL_SUPABASE_SERVICE_ROLE_KEY) {
    throw new IsolatedDbEnvError("TEST_SUPABASE_SERVICE_ROLE_KEY and LOCAL_SUPABASE_SERVICE_ROLE_KEY differ.");
  }
  const apiPort = checkUrl("LOCAL_SUPABASE_URL", env.LOCAL_SUPABASE_URL!, env);
  const dbPort = checkUrl("TEST_SUPABASE_DB_URL", env.TEST_SUPABASE_DB_URL!, env);
  assertIsolatedDbUrl(env);
  if (apiPort === dbPort) throw new IsolatedDbEnvError("API and database URLs use the same port.");
}
