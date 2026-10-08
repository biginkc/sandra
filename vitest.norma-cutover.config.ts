import path from "node:path";

import { defineConfig } from "vitest/config";

import { requireLoopbackPostgresUrl } from "./src/lib/testing/loopback-postgres-url";

// Norma cutover gate: schema-stage tests run on the POST-migration schema (no excluded migrations) with main's current runtime. The legacy stress suite runs separately on the pre-disable schema (vitest.norma-stress.config.ts). Needs a LOCAL Supabase
// Postgres to clone the schema from; it creates and drops its own scratch
// database and never writes to the source database.
const sourceUrl = requireLoopbackPostgresUrl(
  process.env.NORMA_STRESS_SOURCE_DB_URL ?? process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);

export default defineConfig({
  test: {
    include: ["src/lib/norma/cutover/**/*.integration.test.ts"],
    setupFiles: ["src/lib/norma/stress/setup.ts"],
    environment: "node",
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
