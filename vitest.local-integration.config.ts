import path from "node:path";

import { defineConfig } from "vitest/config";

import { requireLoopbackPostgresUrl } from "./src/lib/testing/loopback-postgres-url";

const defaultLocalDbUrl = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
const dbUrl = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? defaultLocalDbUrl);

export default defineConfig({
  test: {
    include: [
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
      "supabase/migrations/20261005130000_offer_follow_up_chain.integration.test.ts",
      "supabase/migrations/20261005130100_set_lead_next_action_next_step.integration.test.ts",
      "supabase/migrations/20261005130200_jitter_softphone_callback_next_step.integration.test.ts",
      "supabase/migrations/20261005130300_jitter_writeback_callback_next_step.integration.test.ts",
      "supabase/migrations/20261005130400_norma_complete_call_next_step.integration.test.ts",
      "supabase/migrations/20261005130500_norma_needs_review_next_step.integration.test.ts",
      "supabase/migrations/20261005122000_my_leads_housekeeping_reassign_sources.integration.test.ts",
      "supabase/migrations/20261005140000_my_leads_housekeeping_reassign_queue_scope.integration.test.ts",
      "supabase/migrations/20261005150000_my_leads_call_next.integration.test.ts",
      "supabase/migrations/20261005160000_post_call_prompt_support.integration.test.ts",
      "supabase/migrations/20261005170000_seller_appointment_reminders.integration.test.ts",
      "src/lib/my-leads/seller-reminder.transport.integration.test.ts",
      "supabase/migrations/20260929237000_sequence_detail.integration.test.ts",
      "supabase/migrations/20260929239000_drips_followups.integration.test.ts",
      "supabase/migrations/20260929239000_drips_snapshot_isolation.integration.test.ts",
      "supabase/migrations/20260930035000_drip_reply_failed_send_keeps_flag.integration.test.ts",
      "supabase/migrations/20260930001000_recording_endpoint_configuration.integration.test.ts",
      "supabase/migrations/20261002110100_search_properties.integration.test.ts",
      "tests/search-oracle/oracle-comparison.integration.test.ts",
      "src/lib/leads/outreach-dispo.db.integration.test.ts",
    ],
    environment: "node",
    reporters: ["default"],
    testTimeout: 30_000,
    fileParallelism: false,
    env: {
      TEST_SUPABASE_DB_URL: dbUrl,
      // Local stack API (loopback only; suites call assertLocalOnlyTestEnv).
      // Keys default to the public Supabase CLI demo keys, never hosted ones.
      TEST_SUPABASE_URL: process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54331",
      TEST_SUPABASE_ANON_KEY: process.env.LOCAL_SUPABASE_ANON_KEY ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
      TEST_SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@tests": path.resolve(__dirname, "./tests"),
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
});
