import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/search-oracle/**/*.test.ts"],
    // The comparison test needs the local Supabase stack: vitest.local-integration.config.ts.
    exclude: ["tests/search-oracle/**/*.integration.test.ts"], environment: "node" },
});
