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

export default async function setup(): Promise<() => Promise<void>> {
  const env = loadTestEnv();
  const dbUrl = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
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

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
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
      console.log(`[integration] still waiting for the suite lock (${secs}s)`);
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

  // Supavisor can reap idle sessions; the lock connection sits idle for
  // the whole run, so ping it. unref() keeps the timer from holding the
  // process open if vitest exits without teardown.
  const keepalive = setInterval(() => {
    client.query("select 1").catch((err: Error) => {
      console.error(
        `[integration] suite-lock connection lost (${err.message}) — ` +
          "another run could start mid-suite",
      );
    });
  }, KEEPALIVE_INTERVAL_MS);
  keepalive.unref();
  client.on("error", (err) => {
    console.error(
      `[integration] suite-lock connection errored (${err.message}) — ` +
        "another run could start mid-suite",
    );
  });

  return async function teardown(): Promise<void> {
    clearInterval(keepalive);
    // Ending the connection releases the session-level lock; no explicit
    // unlock needed (and it would throw if the connection already died).
    await client.end().catch(() => {});
  };
}
