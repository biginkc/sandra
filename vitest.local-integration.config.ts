import path from "node:path";

import { defineConfig } from "vitest/config";

import { requireLoopbackPostgresUrl } from "./src/lib/testing/loopback-postgres-url";

const defaultLocalDbUrl = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
const dbUrl = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? defaultLocalDbUrl);

export default defineConfig({
  test: {
    include: [
      "supabase/migrations/20260927023443_dialpad_cti_kpi_seller_speech.integration.test.ts",
      "supabase/migrations/20260929034021_dialpad_cti_foundation.integration.test.ts",
      "supabase/migrations/20260929120000_dialpad_cti_call_projection.integration.test.ts",
      "supabase/migrations/20260929180000_dialpad_cti_dispatch.integration.test.ts",
      "supabase/migrations/20260929210000_dialpad_recording_foundation.integration.test.ts",
      "supabase/migrations/20260929200000_dialpad_cti_custom_data.integration.test.ts",
      "supabase/migrations/20260929237000_sequence_detail.integration.test.ts",
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
