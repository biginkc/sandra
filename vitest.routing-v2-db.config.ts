import path from "node:path";
import { defineConfig } from "vitest/config";

/** Raw PostgreSQL routing tests: use the repository's DB-only isolation guard. */
export default defineConfig({
  test: {
    include: ["supabase/migrations/*routing_v2*.integration.test.ts"],
    environment: "node",
    globalSetup: ["./src/lib/testing/isolated-db-url.global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});
