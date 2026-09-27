import path from "node:path";

import { defineConfig } from "vitest/config";

const defaultLocalDbUrl = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
const dbUrl = process.env.TEST_SUPABASE_DB_URL ?? defaultLocalDbUrl;
const hostname = new URL(dbUrl).hostname;

if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
  throw new Error("Local migration integration tests require a loopback Supabase database.");
}

export default defineConfig({
  test: {
    include: [
      "supabase/migrations/20260927023443_dialpad_cti_kpi_seller_speech.integration.test.ts",
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
