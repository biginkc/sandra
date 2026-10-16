import path from "node:path";

import { defineConfig } from "vitest/config";

// Norma stress gate (.planning/norma/PLAN.md section 9). Needs a LOCAL Supabase
// Postgres to clone the schema from; it creates and drops its own scratch
// database and never writes to the source database.
// No default: the globalSetup guard (isolated-db-env.ts) requires an explicit,
// loopback, non-shared-port source before any test file loads.
const sourceUrl = process.env.NORMA_STRESS_SOURCE_DB_URL ?? process.env.TEST_SUPABASE_DB_URL ?? "";

export default defineConfig({
  test: {
    include: ["src/lib/norma/stress/**/*.integration.test.ts"],
    setupFiles: ["src/lib/norma/stress/setup.ts"],
    environment: "node",
    globalSetup: ["./src/lib/testing/isolated-norma-stress.global-setup.ts"],
    reporters: ["default"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    env: { NORMA_STRESS_SOURCE_DB_URL: sourceUrl },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@tests": path.resolve(__dirname, "./tests"),
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
});
