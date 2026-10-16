import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["supabase/migrations/*_norma_inbound_call_records.integration.test.ts"],
  environment: "node", globalSetup: ["./src/lib/testing/isolated-db-url.global-setup.ts"], fileParallelism: false, testTimeout: 30_000,
  env: { TEST_SUPABASE_DB_URL: process.env.TEST_SUPABASE_DB_URL ?? "" },
} });
