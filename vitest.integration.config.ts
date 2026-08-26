import { defineConfig } from "vitest/config";
import path from "node:path";

import { loadTestEnv } from "./tests/integration/env";

/**
 * Integration suite — hits the `sandra-crm-test` Supabase project (a real
 * hosted Postgres) so coverage includes RLS, Realtime publications, pg_*
 * extensions, and SECURITY DEFINER functions. Runs only via `npm run
 * test:integration`, not on the pre-commit hook (would be too slow and
 * requires network + creds).
 *
 * Env is loaded from `.env.test.local` via the minimal parser in
 * `tests/integration/env.ts` (shared with the global setup) so we don't
 * pull in `dotenv` just for this.
 */

const env = loadTestEnv();

export default defineConfig({
  test: {
    include: [
      "src/**/*.integration.test.ts",
      // Migration integration tests live alongside the migration SQL files.
      // Added in phase 02-05 to include 046_backfill*.integration.test.ts.
      "supabase/migrations/**/*.integration.test.ts",
    ],
    environment: "node",
    reporters: ["default"],
    // Cross-process mutex: a Postgres advisory lock so only one
    // integration run truncates the shared test DB at a time — covers
    // other worktrees, agents, and machines, which a lockfile can't.
    globalSetup: ["./tests/integration/global-setup.ts"],
    // Real DB calls — 30s per test covers a reset + a few inserts + a
    // query with comfortable headroom.
    testTimeout: 30000,
    // Sequential by default — tests TRUNCATE shared tables in beforeEach,
    // so parallel execution would race.
    fileParallelism: false,
    env: {
      TEST_SUPABASE_URL:
        process.env.TEST_SUPABASE_URL ?? env.TEST_SUPABASE_URL ?? "",
      TEST_SUPABASE_ANON_KEY:
        process.env.TEST_SUPABASE_ANON_KEY ?? env.TEST_SUPABASE_ANON_KEY ?? "",
      TEST_SUPABASE_SERVICE_ROLE_KEY:
        process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ??
        env.TEST_SUPABASE_SERVICE_ROLE_KEY ??
        "",
      // Force the mock address verifier so integration tests never call
      // SmartyStreets for real. Real CASS coverage lives in the
      // `smartystreets.test.ts` unit suite.
      ADDRESS_VERIFIER_PROVIDER: "mock",
      // Same story for SMS — mock provider so no real Dialpad calls.
      MESSAGING_PROVIDER: "mock",
      // Skip-trace also defaults to mock. Tracerfy real-API coverage
      // lives in the unit suite (src/lib/skip-trace/providers/tracerfy.test.ts).
      SKIP_TRACE_PROVIDER: "mock",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@tests": path.resolve(__dirname, "./tests"),
      "server-only": path.resolve(
        __dirname,
        "./node_modules/server-only/empty.js",
      ),
    },
  },
});
