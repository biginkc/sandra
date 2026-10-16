import path from "node:path";
import { defineConfig } from "vitest/config";
// Loopback-only. The queue migration has no reserved version yet, so match both the unversioned
// RED file and its later versioned name.
export default defineConfig({
  test: {
    include: ["supabase/migrations/*norma_call_queue*.integration.test.ts"],
    environment: "node", globalSetup: ["./src/lib/testing/isolated-db-url.global-setup.ts"], fileParallelism: false, testTimeout: 30_000,
    env: { TEST_SUPABASE_DB_URL: process.env.TEST_SUPABASE_DB_URL ?? "" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@tests": path.resolve(__dirname, "./tests"),
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
});
