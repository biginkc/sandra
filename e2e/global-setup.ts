import { Client } from "pg";

/**
 * Playwright globalSetup: hold a session-level Postgres advisory lock for
 * the whole E2E run against the dedicated CI Supabase project.
 *
 * Why this exists: GitHub Actions concurrency groups only serialize runs
 * whose *currently checked-out* e2e.yml carries the same group string. A
 * PR branch that hasn't rebased onto a concurrency-group change runs under
 * its own group text, so two branches' E2E jobs can execute in parallel
 * against the same dedicated CI project and interleave truncates/writes —
 * confirmed by a real collision: run 33466909909 (attempt 3) overlapped
 * eSign run 33473393844 for ~8 minutes, producing row-count drift, FK
 * violations, and 500s. A DB-level lock is immune to that drift because it
 * lives in the database itself, not in GitHub's per-branch YAML.
 *
 * The lock is a plain advisory lock keyed by hashtext('sandra-e2e-suite'),
 * held on a single dedicated connection for the whole run — Postgres
 * releases it automatically if the process dies, so a crashed run never
 * wedges the suite.
 *
 * CI is where this guard matters — the e2e-ci environment always carries
 * the E2E_CI_SUPABASE_DB_URL secret. A run without it (local, or an
 * environment that hasn't been provisioned yet) proceeds WITHOUT the lock
 * rather than failing; failing every local run over a guard that protects
 * a shared CI resource would just train people to skip the suite.
 */
const LOCK_KEY_TEXT = "sandra-e2e-suite";
const WAIT_LOG_INTERVAL_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const LOG_PREFIX = "[e2e-lock]";

async function noopTeardown(): Promise<void> {}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const dbUrl = process.env.E2E_CI_SUPABASE_DB_URL;
  if (!dbUrl) {
    console.warn(
      `${LOG_PREFIX} WARNING: E2E_CI_SUPABASE_DB_URL is not set — running ` +
        "WITHOUT the cross-run advisory lock. This run is not protected " +
        "against another E2E run touching the same tables mid-run. CI " +
        "always sets this secret; a missing value here means either a " +
        "local run or an unprovisioned environment.",
    );
    return noopTeardown;
  }

  const client = new Client({ connectionString: dbUrl });
  try {
    await client.connect();
    // The blocking lock wait below can outlast any statement timeout the
    // role inherits; this session only ever locks and heartbeats.
    await client.query("set statement_timeout = 0");

    const { rows } = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as acquired",
      [LOCK_KEY_TEXT],
    );
    if (!rows[0].acquired) {
      console.log(`${LOG_PREFIX} waiting for e2e suite lock...`);
      const startedAt = Date.now();
      const waitLogger = setInterval(() => {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        console.log(`${LOG_PREFIX} still waiting for e2e suite lock (${secs}s)`);
      }, WAIT_LOG_INTERVAL_MS);
      try {
        await client.query("select pg_advisory_lock(hashtext($1))", [LOCK_KEY_TEXT]);
      } finally {
        clearInterval(waitLogger);
      }
      console.log(`${LOG_PREFIX} e2e suite lock acquired — starting run`);
    }
  } catch (err) {
    // Connection failed (bad host, no network, wrong project) — this is
    // exactly the "pg can't connect" case: warn and proceed unlocked
    // rather than failing the whole suite over the guard itself.
    console.warn(
      `${LOG_PREFIX} WARNING: could not acquire the DB advisory lock ` +
        `(${(err as Error).message}). Proceeding WITHOUT the lock rather ` +
        "than failing the run.",
    );
    await client.end().catch(() => {});
    return noopTeardown;
  }

  // The lock is only real while this session lives. If the connection dies
  // (idle-session reap, network drop), Postgres releases the advisory lock
  // and another run could start overlapping mid-run — the exact race this
  // guards against. So a lost lock session is FATAL: kill the run rather
  // than continue unlocked. `teardown` sets `released` first so a clean
  // shutdown never trips this.
  let released = false;
  const abortOnLockLoss = (reason: string): void => {
    if (released) return;
    released = true;
    console.error(
      `${LOG_PREFIX} FATAL: suite-lock connection lost (${reason}). ` +
        "Aborting the run instead of continuing unlocked — re-run once " +
        "the connection is stable.",
    );
    // No graceful "fail the whole run" API exists in a Playwright
    // globalSetup; exiting non-zero is the honest signal that the mutex
    // guarantee broke.
    process.exit(1);
  };
  // The lock connection sits idle for the whole run; ping it periodically
  // so an idle-session reaper doesn't quietly drop it. unref() keeps the
  // timer from holding the process open if the runner exits without
  // teardown.
  const keepalive = setInterval(() => {
    client.query("select 1").catch((err: Error) => abortOnLockLoss(err.message));
  }, KEEPALIVE_INTERVAL_MS);
  keepalive.unref();
  client.on("error", (err) => abortOnLockLoss(err.message));

  return async function teardown(): Promise<void> {
    // Mark released before tearing down so the clean disconnect below can't
    // fire abortOnLockLoss via the `error` handler.
    released = true;
    clearInterval(keepalive);
    client.removeAllListeners("error");
    // Ending the connection releases the session-level lock; no explicit
    // unlock needed (and it would throw if the connection already died).
    await client.end().catch(() => {});
  };
}
