import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["scripts/inbox-test-readonly-fixture.t1.test.ts"],
    environment: "node",
    fileParallelism: false,
    reporters: ["default"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
});
