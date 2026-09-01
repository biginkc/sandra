import { Client } from "pg";

/**
 * Playwright globalSetup: hold a transaction-scoped Postgres advisory lock
 * for the whole E2E run against the dedicated CI Supabase project.
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
 * WHY pg_advisory_XACT_lock and not the simpler session-level
 * pg_advisory_lock (used by tests/integration/global-setup.ts against a
 * different project): this dedicated CI project has NO direct-connection
 * DNS and its connection pooler runs in TRANSACTION mode only (port 6543).
 * A transaction-mode pooler can reassign a session to a different backend
 * between statements, so a session-level lock taken by one statement can
 * silently end up "held" by a backend no later statement on this
 * connection ever touches again — it doesn't protect anything. The one
 * guarantee a transaction-mode pooler DOES give is pinning an *open
 * transaction* to a single backend for its duration. So: BEGIN once,
 * take the lock inside that transaction with pg_advisory_xact_lock, and
 * never COMMIT/ROLLBACK until teardown — the open transaction is what
 * keeps this connection nailed to one backend for the whole run. Do not
 * "simplify" this back to a session-level lock or a direct connection;
 * both are unavailable on this project.
 *
 * The lock is keyed by hashtext('sandra-e2e-suite'), held inside one
 * transaction on a single dedicated connection for the whole run —
 * Postgres releases it automatically (transaction end) if the process
 * dies, so a crashed run never wedges the suite.
 *
 * CI is where this guard matters — the e2e-ci environment always carries
 * the E2E_CI_SUPABASE_DB_URL secret (a pooler URL, sslmode=no-verify — the
 * pooler's cert is Supabase's own CA on a disposable CI project). A run
 * without the secret (local, or an environment that hasn't been
 * provisioned yet) or one where the connection fails proceeds WITHOUT the
 * lock rather than failing; failing every local run over a guard that
 * protects a shared CI resource would just train people to skip the suite.
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

  // Pass the connection string through unmodified — its sslmode=no-verify
  // query param is parsed by pg's own connection-string handling. Setting
  // an explicit `ssl` option here would override that parsing, so don't.
  const client = new Client({ connectionString: dbUrl });
  try {
    await client.connect();
    // The blocking lock wait below can outlast any statement timeout the
    // role inherits; this session only ever locks and heartbeats.
    await client.query("set statement_timeout = 0");
    // Open the transaction that pins this connection to one pooler backend
    // for the rest of the run. Nothing else in this transaction ever
    // commits or rolls back until teardown.
    await client.query("BEGIN");

    const { rows } = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_xact_lock(hashtext($1)) as acquired",
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
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY_TEXT]);
      } finally {
        clearInterval(waitLogger);
      }
      console.log(`${LOG_PREFIX} e2e suite lock acquired — starting run`);
    }
  } catch (err) {
    // Connection or lock-acquisition failed (bad host, no network, wrong
    // project) — this is exactly the "pg can't connect" case: warn and
    // proceed unlocked rather than failing the whole suite over the guard
    // itself. Roll back any open transaction before ending the connection
    // — never leave a dangling transaction on a client we're about to
    // discard, and never issue a bare ROLLBACK without also ending the
    // client right after.
    console.warn(
      `${LOG_PREFIX} WARNING: could not acquire the DB advisory lock ` +
        `(${(err as Error).message}). Proceeding WITHOUT the lock rather ` +
        "than failing the run.",
    );
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
    return noopTeardown;
  }

  // The lock is only real while this transaction stays open on this
  // connection. If the connection dies (idle-session reap, network drop),
  // Postgres ends the transaction and releases the advisory lock, and
  // another run could start overlapping mid-run — the exact race this
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
    // guarantee broke. The process death also closes the connection —
    // there is no live client left to roll back or end here.
    process.exit(1);
  };
  // The lock connection sits idle (inside its one open transaction) for
  // the whole run; ping it periodically, still inside that same
  // transaction, so an idle-session reaper doesn't quietly drop it.
  // unref() keeps the timer from holding the process open if the runner
  // exits without teardown.
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
    // COMMIT (not ROLLBACK) — nothing in this transaction did real work
    // beyond taking the lock, so either ends the transaction and releases
    // the xact-scoped lock identically; COMMIT is the honest description
    // of "this run finished cleanly." Then end the connection.
    await client.query("COMMIT").catch(() => {});
    await client.end().catch(() => {});
  };
}
