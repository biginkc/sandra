import { defineConfig } from "vitest/config";
import { requireLoopbackPostgresUrl } from "./src/lib/testing/loopback-postgres-url";
export default defineConfig({ test: {
  include: ["supabase/migrations/*_norma_outbound_recording_state.integration.test.ts"],
  environment: "node", fileParallelism: false, testTimeout: 30_000,
  env: { TEST_SUPABASE_DB_URL: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres") },
} });
