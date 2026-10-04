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
    // This migration replays DDL against an isolated loopback database and
    // rejects hosted URLs. It has its own local-only runner so this hosted
    // suite cannot accidentally select it.
    exclude: [
      // Destructive + local-only (assertLocalOnlyEnvironment); runs via
      // vitest.filter-local.config.ts against a disposable local stack.
      "src/lib/prospects/filter-to-supabase.integration.test.ts",
      "src/lib/prospects/filter-cache-triggers.integration.test.ts",
      "supabase/migrations/20260929238000_sequence_replace_steps.integration.test.ts",
      "supabase/migrations/20260930038000_sequence_canary_controls.integration.test.ts",
      "supabase/migrations/20261001200000_direct_calls.integration.test.ts",
      "supabase/migrations/20261002020000_direct_browser_watchdog.integration.test.ts",
      "supabase/migrations/20261002005023_direct_recording_integration.integration.test.ts",
      "supabase/migrations/20261002015000_direct_recording_library.integration.test.ts",
      "supabase/migrations/20261002016200_direct_training_wrapup.integration.test.ts",
      "supabase/migrations/20261002120000_norma_call_requests.integration.test.ts",
      "supabase/migrations/20261002120100_norma_m2_hardening.integration.test.ts",
      "supabase/migrations/20261002120200_norma_m2_review_fixes.integration.test.ts",
      "supabase/migrations/20260927023443_dialpad_cti_kpi_seller_speech.integration.test.ts",
      "supabase/migrations/20260929034021_dialpad_cti_foundation.integration.test.ts",
      "supabase/migrations/20260929120000_dialpad_cti_call_projection.integration.test.ts",
      "supabase/migrations/20260929180000_dialpad_cti_dispatch.integration.test.ts",
      "supabase/migrations/20260929210000_dialpad_recording_foundation.integration.test.ts",
      "supabase/migrations/20260930030000_dialpad_recording_timing.integration.test.ts",
      "supabase/migrations/20260930031000_dialpad_recording_provider_window_finalizer.integration.test.ts",
      "supabase/migrations/20260929200000_dialpad_cti_custom_data.integration.test.ts",
      "supabase/migrations/20260929236500_my_leads_drip_scope.integration.test.ts",
      "supabase/migrations/20261003120000_my_leads_queue_row_lookup.integration.test.ts",
      "supabase/migrations/20261003130000_my_leads_conflicts_non_retryable.integration.test.ts",
      "supabase/migrations/20261005100000_my_leads_housekeeping_tools.integration.test.ts",
      "supabase/migrations/20261005100100_my_leads_housekeeping_reassign.integration.test.ts",
      "supabase/migrations/20261005110000_acquisition_attempt_outcome_voicemail_not_logged.integration.test.ts",
      "supabase/migrations/20261005120000_next_step_schema.integration.test.ts",
      "supabase/migrations/20261005120500_fn_create_next_step.integration.test.ts",
      "supabase/migrations/20261005121000_next_step_read_model.integration.test.ts",
      "supabase/migrations/20261005121200_next_step_mode_aware_lifecycle.integration.test.ts",
      "supabase/migrations/20261005121500_next_step_relabel_functions.integration.test.ts",
      "supabase/migrations/20260929237000_sequence_detail.integration.test.ts",
      "supabase/migrations/20260929239000_drips_followups.integration.test.ts",
      "supabase/migrations/20260929239000_drips_snapshot_isolation.integration.test.ts",
      "supabase/migrations/20260930035000_drip_reply_failed_send_keeps_flag.integration.test.ts",
      "supabase/migrations/20260930001000_recording_endpoint_configuration.integration.test.ts",
      "supabase/migrations/20260930030000_dialpad_recording_timing.integration.test.ts",
      "supabase/migrations/20261002110100_search_properties.integration.test.ts",
      "tests/search-oracle/oracle-comparison.integration.test.ts",
      "src/lib/prospects/search-filter-composition.integration.test.ts",
      "src/lib/prospects/search-eval-budget.integration.test.ts",
      // Local-only: designation setup + failure injection need loopback Postgres.
      "src/lib/leads/outreach-dispo.db.integration.test.ts",
      // Slack rehearsal and fixtures must never run against the hosted project.
      "src/lib/integrations/slack/unfurl-data.db.integration.test.ts",
      "supabase/migrations/20261003130001_slack_lead_unfurl_foundation.integration.test.ts",
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
    hookTimeout: 120000,
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
      // Same session-pooler URL global-setup.ts already uses for the
      // suite's advisory lock — passed through here too so a test file's
      // own beforeAll (a worker process, unlike globalSetup which runs in
      // the main process and reads it directly via loadTestEnv()) can
      // also connect directly, e.g. to replay a migration under the same
      // lock rather than trusting the shared project's existing schema.
      TEST_SUPABASE_DB_URL:
        process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL ?? "",
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
