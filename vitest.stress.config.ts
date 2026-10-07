import path from "node:path";

import { defineConfig } from "vitest/config";

/** Unit tests for the chaos-day stress harness (e2e/stress). Opt-in script (`npm run test:stress-unit`); the verify workflow also runs it so guard regressions are caught. */
export default defineConfig({
  test: {
    include: ["e2e/stress/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
});
