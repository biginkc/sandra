import path from "node:path";

import { defineConfig } from "vitest/config";

// Forward-recovery proof for the Norma queue cutover (supabase/rollbacks/norma_queue_recovery.integration.test.ts).
// Loopback-only; needs three disposable databases (the test skips itself unless all three are set):
//   NORMA_ROLLBACK_BASELINE_DB_URL  chain through main's high-water, no 20261009010000 / 20261009010100
//   NORMA_ROLLBACK_MID_DB_URL       BASELINE + 20261009010000 (legacy claim disabled)
//   NORMA_ROLLBACK_FULL_DB_URL      BASELINE + 20261009010000 + 20261009010100 (queue installed)
//   npx vitest run --config vitest.norma-queue-recovery.config.ts
export default defineConfig({
  test: {
    include: ["supabase/rollbacks/norma_queue_recovery.integration.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@tests": path.resolve(__dirname, "./tests"),
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
});
