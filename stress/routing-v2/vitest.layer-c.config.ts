import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Routing v2 stress, Layer C (disposable local stack only). Every value must point at a stack
 * you own; the isolation guard runs as globalSetup and refuses shared/hosted targets.
 *   source <stack.env>; npx vitest run --config stress/routing-v2/vitest.layer-c.config.ts [file]
 */
const root = path.resolve(__dirname, "../..");
export default defineConfig({
  root,
  test: {
    include: ["stress/routing-v2/layer-c/**/*.test.ts"],
    environment: "node",
    globalSetup: [path.join(root, "src/lib/testing/isolated-db-env.global-setup.ts")],
    reporters: ["default"],
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    env: {
      TEST_SUPABASE_DB_URL: process.env.TEST_SUPABASE_DB_URL ?? "",
      TEST_SUPABASE_URL: process.env.LOCAL_SUPABASE_URL ?? "",
      TEST_SUPABASE_ANON_KEY: process.env.LOCAL_SUPABASE_ANON_KEY ?? "",
      TEST_SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY ?? "",
    },
  },
  resolve: {
    alias: {
      "@": path.join(root, "src"),
      "@tests": path.join(root, "tests"),
      "server-only": path.join(root, "node_modules/server-only/empty.js"),
    },
  },
});
