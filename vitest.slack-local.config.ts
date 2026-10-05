import path from "node:path";

import { defineConfig } from "vitest/config";

import { assertLocalOnlyEnvironment } from "./src/lib/testing/local-only-guard";

const dbUrl =
  process.env.SLACK_LOCAL_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
const apiUrl = process.env.SLACK_LOCAL_API_URL ?? "http://127.0.0.1:54331";
assertLocalOnlyEnvironment({
  TEST_SUPABASE_URL: apiUrl,
  TEST_SUPABASE_DB_URL: dbUrl,
});

export default defineConfig({
  test: {
    include: [
      "src/lib/integrations/slack/unfurl-data.db.integration.test.ts",
      "supabase/migrations/20261003130001_slack_lead_unfurl_foundation.integration.test.ts",
      "supabase/migrations/20261003160000_slack_workspace_preview_policy.integration.test.ts",
      "supabase/migrations/20261007130000_slack_canary_safety.integration.test.ts",
      "supabase/migrations/20261007130100_slack_canary_execution_fence.integration.test.ts",
    ],
    environment: "node",
    reporters: ["default"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: {
      TEST_SUPABASE_URL: apiUrl,
      TEST_SUPABASE_ANON_KEY:
        process.env.SLACK_LOCAL_ANON_KEY ??
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
      TEST_SUPABASE_SERVICE_ROLE_KEY:
        process.env.SLACK_LOCAL_SERVICE_KEY ??
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
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
