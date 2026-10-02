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
      "supabase/migrations/20261002020000_norma_call_requests.integration.test.ts",
      "supabase/migrations/20261002030000_norma_m2_hardening.integration.test.ts",
      "supabase/migrations/20260927023443_dialpad_cti_kpi_seller_speech.integration.test.ts",
      "supabase/migrations/20260929034021_dialpad_cti_foundation.integration.test.ts",
      "supabase/migrations/20260929120000_dialpad_cti_call_projection.integration.test.ts",
      "supabase/migrations/20260929180000_dialpad_cti_dispatch.integration.test.ts",
      "supabase/migrations/20260929210000_dialpad_recording_foundation.integration.test.ts",
      "supabase/migrations/20260930030000_dialpad_recording_timing.integration.test.ts",
      "supabase/migrations/20260930031000_dialpad_recording_provider_window_finalizer.integration.test.ts",
      "supabase/migrations/20260929200000_dialpad_cti_custom_data.integration.test.ts",
      "supabase/migrations/20260929236500_my_leads_drip_scope.integration.test.ts",
      "supabase/migrations/20260929237000_sequence_detail.integration.test.ts",
      "supabase/migrations/20260929239000_drips_followups.integration.test.ts",
      "supabase/migrations/20260929239000_drips_snapshot_isolation.integration.test.ts",
      "supabase/migrations/20260930035000_drip_reply_failed_send_keeps_flag.integration.test.ts",
      "supabase/migrations/20260930001000_recording_endpoint_configuration.integration.test.ts",
    ],
    environment: "node",
    reporters: ["default"],
    testTimeout: 30_000,
    fileParallelism: false,
    env: {
      TEST_SUPABASE_DB_URL: dbUrl,
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
