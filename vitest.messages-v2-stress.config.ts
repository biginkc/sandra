import path from "node:path";

import { defineConfig } from "vitest/config";

import { assertStressDbEnv } from "./scripts/messages-v2/stress/core";

/**
 * Messages v2 Stage 5 dispatch lane. Unlike vitest.local-integration.config.ts this config has
 * NO defaults: every binding must be set explicitly, and the long-running dev stack
 * (127.0.0.1:54331 / 54329) is refused. See scripts/messages-v2/stress/core.ts assertStressDbEnv.
 */
assertStressDbEnv(process.env);

export default defineConfig({
  test: {
    include: ["scripts/messages-v2/stress/dispatch.stress.integration.test.ts", "scripts/messages-v2/stress/retained-findings.db.integration.test.ts"],
    environment: "node",
    reporters: ["default"],
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    env: {
      TEST_SUPABASE_DB_URL: process.env.TEST_SUPABASE_DB_URL!,
      TEST_SUPABASE_URL: process.env.TEST_SUPABASE_URL!,
      TEST_SUPABASE_ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY!,
      TEST_SUPABASE_SERVICE_ROLE_KEY: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!,
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
