import { Client } from "pg";

/**
 * Playwright globalSetup: hold a transaction-scoped Postgres advisory lock
 * for the whole E2E run against the dedicated CI Supabase project.
 *
 * Why this exists: this workflow's own GitHub concurrency group only
 * serializes runs whose *currently checked-out* e2e.yml carries the same
 * group string — a branch that hasn't rebased onto a group-string change
 * runs under different text and can execute in parallel against the same
 * dedicated CI project, interleaving writes. Confirmed by a real
 * collision: run 33466909909 (attempt 3) overlapped eSign run 33473393844
 * for ~8 minutes, producing row-count drift, FK violations, and 500s. A
 * DB-level lock is immune to that drift because it lives in the database
 * itself, not in GitHub's per-branch YAML.
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
 * FAIL-CLOSED IN CI: this guard only means something if a broken guard is
 * loud. In CI (process.env.CI/GITHUB_ACTIONS set), a missing
 * E2E_CI_SUPABASE_DB_URL, a failed connection, or a failed lock
 * acquisition all THROW and abort the suite — CI always carries this
 * secret, so any of those mean the guard itself is broken, and running
 * "protected" while it silently isn't is worse than failing loudly.
 * Outside CI (local dev — where this secret typically isn't configured,
 * and a stray local run racing the shared CI project isn't the threat
 * model) the same conditions warn and proceed unlocked instead, so a
 * developer without the secret can still run the suite.
 *
 * The connection-string-vs-target check below is NOT CI-gated: a lock
 * taken against the wrong project protects nothing regardless of
 * environment, so a mismatch always throws.
 */
const LOCK_KEY_TEXT = "sandra-e2e-suite";
const WAIT_LOG_INTERVAL_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const LOG_PREFIX = "[e2e-lock]";
// Supabase's pooler usernames are `postgres.<20-char-project-ref>`.
const POOLER_USERNAME_PATTERN = /^postgres\.([a-z0-9]+)$/;

async function noopTeardown(): Promise<void> {}

type MinimalEnvironment = Readonly<Record<string, string | undefined>>;

export function isCiEnvironment(env: MinimalEnvironment = process.env): boolean {
  return env.GITHUB_ACTIONS === "true" || env.CI === "1" || env.CI === "true";
}

/**
 * Parse the lock connection string and, when E2E_CI_SUPABASE_PROJECT_REF
 * is set, confirm the pooler username's project ref matches it. Throws
 * (unconditionally — not CI-gated) on an unparseable URL, an unparseable
 * pooler username, or a ref mismatch: a lock taken against a different
 * project than the one under test isn't a degraded guard, it's a wrong
 * one, so this never falls back to "proceed unlocked."
 */
export function assertLockTargetsExpectedProject(
  dbUrl: string,
  env: MinimalEnvironment = process.env,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(dbUrl);
  } catch {
    throw new Error(
      `${LOG_PREFIX} E2E_CI_SUPABASE_DB_URL is not a valid connection URL.`,
    );
  }
  const expectedRef = env.E2E_CI_SUPABASE_PROJECT_REF?.trim().toLowerCase();
  if (!expectedRef) return parsed;
  const match = POOLER_USERNAME_PATTERN.exec(decodeURIComponent(parsed.username));
  const actualRef = match?.[1];
  if (!actualRef || actualRef !== expectedRef) {
    throw new Error(
      `${LOG_PREFIX} E2E_CI_SUPABASE_DB_URL's pooler username does not ` +
        `match E2E_CI_SUPABASE_PROJECT_REF (expected project ref ` +
        `"${expectedRef}", got ${actualRef ? `"${actualRef}"` : "an unparseable username"}). ` +
        "Refusing to take the suite lock against a different project than the one under test.",
    );
  }
  return parsed;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const ci = isCiEnvironment();
  const dbUrl = process.env.E2E_CI_SUPABASE_DB_URL;
  if (!dbUrl) {
    const reason =
      "E2E_CI_SUPABASE_DB_URL is not set — the E2E suite would have no " +
      "cross-run advisory lock protecting the dedicated CI project.";
    if (ci) {
      throw new Error(
        `${LOG_PREFIX} FATAL: ${reason} CI always sets this secret, so a ` +
          "missing value here is a real misconfiguration — aborting " +
          "instead of running unprotected against a shared resource.",
      );
    }
    console.warn(
      `${LOG_PREFIX} WARNING: ${reason} Proceeding WITHOUT the lock — a ` +
        "local run without the secret isn't the concurrent-CI-run race " +
        "this guards against.",
    );
    return noopTeardown;
  }

  // Confirm the lock connection actually targets the project under test
  // BEFORE attempting to connect — see the function doc for why this is
  // never gated on CI.
  assertLockTargetsExpectedProject(dbUrl);

  // TLS: this project's pooler presents a cert Node's default trust store
  // doesn't chain to, and `verify-full` needs the project's CA cert
  // downloaded from its Supabase dashboard (Database Settings → SSL
  // Configuration) — there is no Management API endpoint for it, only a
  // dashboard download, so it can't be fetched or committed from code
  // alone (confirmed against Supabase's own docs before shipping this).
  // Set `ssl` explicitly rather than relying on the URL's sslmode query
  // param: pg-connection-string's handling of `sslmode` values varies by
  // version, so an explicit option here is the reliable way to get this
  // rather than accidentally falling back to full verification (which
  // would fail against this cert) or plaintext. Justified specifically
  // because this is a disposable, CI-only project holding no real data —
  // the worst case of a MITM'd lock connection is "the advisory lock
  // doesn't protect anything," not credential or data exposure.
  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    // Open the transaction that pins this connection to one pooler backend
    // for the rest of the run FIRST, before anything session-scoped.
    await client.query("BEGIN");
    // SET LOCAL (not a bare SET): scoped to this transaction only, so it
    // can never leak onto another session this same pooled backend serves
    // after our transaction ends — a bare SET on a transaction-mode pooler
    // is session-scoped in Postgres terms but the "session" here is a
    // connection Supavisor can hand to someone else's next statement.
    // The blocking lock wait below can outlast any statement timeout the
    // role inherits; LOCAL means it reverts automatically at COMMIT/ROLLBACK.
    await client.query("SET LOCAL statement_timeout = 0");

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
    // Roll back any open transaction before ending the connection — never
    // leave a dangling transaction on a client we're about to discard, and
    // never issue a bare ROLLBACK without also ending the client right
    // after.
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
    const reason = `could not acquire the DB advisory lock (${(err as Error).message})`;
    if (ci) {
      throw new Error(
        `${LOG_PREFIX} FATAL: ${reason}. Aborting the E2E suite instead of ` +
          "running unprotected in CI — re-run once the connection/lock issue is fixed.",
      );
    }
    console.warn(
      `${LOG_PREFIX} WARNING: ${reason}. Proceeding WITHOUT the lock ` +
        "rather than failing the run.",
    );
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
