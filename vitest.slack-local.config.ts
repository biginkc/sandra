import path from "node:path";

import { defineConfig } from "vitest/config";

// No defaults: the globalSetup guard (isolated-db-env.ts) requires explicit
// SLACK_LOCAL_* values on a private stack before any test file loads.
const dbUrl = process.env.SLACK_LOCAL_DB_URL ?? "";
const apiUrl = process.env.SLACK_LOCAL_API_URL ?? "";

export default defineConfig({
  test: {
    include: [
      "src/lib/integrations/slack/unfurl-data.db.integration.test.ts",
      "supabase/migrations/20261003130001_slack_lead_unfurl_foundation.integration.test.ts",
      "supabase/migrations/20261003160000_slack_workspace_preview_policy.integration.test.ts",
      "supabase/migrations/20261007210000_slack_canary_safety.integration.test.ts",
      "supabase/migrations/20261007210100_slack_canary_execution_fence.integration.test.ts",
    ],
    environment: "node",
    globalSetup: ["./src/lib/testing/isolated-slack-local.global-setup.ts"],
    reporters: ["default"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: {
      TEST_SUPABASE_URL: apiUrl,
      TEST_SUPABASE_ANON_KEY:
        process.env.SLACK_LOCAL_ANON_KEY ?? "",
      TEST_SUPABASE_SERVICE_ROLE_KEY:
        process.env.SLACK_LOCAL_SERVICE_KEY ?? "",
      TEST_SUPABASE_DB_URL: dbUrl,
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
