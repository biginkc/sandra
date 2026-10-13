import path from "node:path";
import { defineConfig } from "vitest/config";
import { requireLoopbackPostgresUrl } from "./src/lib/testing/loopback-postgres-url";
// Loopback-only. The queue migration has no reserved version yet, so match both the unversioned
// RED file and its later versioned name.
export default defineConfig({
  test: {
    include: ["supabase/migrations/*norma_call_queue*.integration.test.ts"],
    environment: "node", fileParallelism: false, testTimeout: 30_000,
    env: { TEST_SUPABASE_DB_URL: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres") },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@tests": path.resolve(__dirname, "./tests"),
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
});
