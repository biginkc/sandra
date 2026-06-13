import { Client } from "pg";

import { loadTestEnv } from "./env";

/**
 * Cross-process mutex for the integration suite.
 *
 * Every test file's beforeEach truncates the shared tenant tables in the
 * hosted `sandra-crm-test` project, so two suites running at once (other
 * worktrees, other agents, other machines) interleave truncates and
 * produce deadlocks plus FK-violation seed failures. A local lockfile
 * can't see other machines, so the mutex lives in the database itself: a
 * session-level Postgres advisory lock held on a dedicated connection
 * for the whole run. Postgres releases it automatically if the process
 * dies, so a crashed run never wedges the suite.
 */
const LOCK_KEY_TEXT = "sandra-integration-suite";
const WAIT_LOG_INTERVAL_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
// The dev project — `client.ts` already refuses to run the suite against
// it. The lock connection must never point here either.
const DEV_PROJECT_REF = "copflsklaefwzipsrjqz";

/** Pull the project ref (subdomain) out of an `https://<ref>.supabase.co` URL. */
function projectRefFromUrl(url: string | undefined): string | null {
  const match = /https?:\/\/([a-z0-9]+)\.supabase\./i.exec(url ?? "");
  return match?.[1] ?? null;
}

export default async function setup(): Promise<() => Promise<void>> {
  const env = loadTestEnv();
  const dbUrl = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  const supabaseUrl = process.env.TEST_SUPABASE_URL ?? env.TEST_SUPABASE_URL;
  if (!dbUrl) {
    throw new Error(
      "Missing TEST_SUPABASE_DB_URL in .env.test.local. The integration " +
        "suite takes a Postgres advisory lock so concurrent runs (other " +
        "worktrees / agents) can't truncate shared tables mid-run. Use the " +
        "SESSION pooler URI (port 5432) for sandra-crm-test — see " +
        "tests/integration/README.md.",
    );
  }
  // The transaction pooler (port 6543) hands the session a different
  // backend per statement, so a session-level advisory lock silently
  // doesn't protect anything. Refuse rather than run unlocked.
  if (/:6543\b/.test(dbUrl)) {
    throw new Error(
      "TEST_SUPABASE_DB_URL points at the transaction pooler (port 6543). " +
        "Session advisory locks need the session pooler (port 5432) or a " +
        "direct connection.",
    );
  }
  // The lock connection MUST target the same project the suite truncates.
  // If it points elsewhere, the mutex is taken in the wrong database while
  // `reset_tenant_tables()` still nukes the shared test DB — the run looks
  // protected but isn't, so concurrent suites still interleave. Mirror the
  // dev-project hard guard in `client.ts`, and require the DB URL to carry
  // the same project ref as TEST_SUPABASE_URL (the pooler user is
  // `postgres.<ref>`; the direct host is `db.<ref>.supabase.co`).
  if (dbUrl.includes(DEV_PROJECT_REF)) {
    throw new Error(
      "TEST_SUPABASE_DB_URL points at the dev project — refusing to run. " +
        "The suite lock must live in the same database that beforeEach truncates.",
    );
  }
  const expectedRef = projectRefFromUrl(supabaseUrl);
  if (expectedRef && !dbUrl.includes(expectedRef)) {
    throw new Error(
      `TEST_SUPABASE_DB_URL does not target the same project as ` +
        `TEST_SUPABASE_URL (${expectedRef}). The suite lock would protect a ` +
        `different database than the one beforeEach truncates — fix ` +
        `.env.test.local so both point at sandra-crm-test.`,
    );
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  // Everything after connect() can throw before vitest has registered the
  // teardown fn, so on any failure close the connection (releasing any lock
  // already taken) before rethrowing — otherwise the pg session leaks.
  try {
    // The blocking lock wait below can outlast any statement timeout the
    // role inherits; this session only ever locks and heartbeats.
    await client.query("set statement_timeout = 0");

    const { rows } = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as acquired",
      [LOCK_KEY_TEXT],
    );
    if (!rows[0].acquired) {
      console.log(
        "[integration] another integration run holds the lock — waiting…",
      );
      const startedAt = Date.now();
      const waitLogger = setInterval(() => {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        console.log(
          `[integration] still waiting for the suite lock (${secs}s)`,
        );
      }, WAIT_LOG_INTERVAL_MS);
      try {
        await client.query("select pg_advisory_lock(hashtext($1))", [
          LOCK_KEY_TEXT,
        ]);
      } finally {
        clearInterval(waitLogger);
      }
      console.log("[integration] suite lock acquired — starting run");
    }
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }

  // The lock is only real while this session lives. If the connection dies
  // (Supavisor reaps the idle session, network drops), Postgres releases
  // the advisory lock and another suite could start truncating the same
  // tables mid-run — the exact race this guards against. So a lost lock
  // session is FATAL: kill the run rather than continue unlocked. `teardown`
  // sets `released` first so a clean shutdown never trips this.
  let released = false;
  const abortOnLockLoss = (reason: string): void => {
    if (released) return;
    released = true;
    console.error(
      `[integration] FATAL: suite-lock connection lost (${reason}). ` +
        "Aborting the run instead of truncating the shared DB unlocked — " +
        "re-run once the connection is stable.",
    );
    // No graceful "fail the whole run" API exists in a vitest globalSetup;
    // exiting non-zero is the honest signal that the mutex guarantee broke.
    process.exit(1);
  };
  // Supavisor can reap idle sessions; the lock connection sits idle for
  // the whole run, so ping it. unref() keeps the timer from holding the
  // process open if vitest exits without teardown.
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
