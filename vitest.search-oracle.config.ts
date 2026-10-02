import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/search-oracle/**/*.test.ts"], environment: "node" },
});
