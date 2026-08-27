import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/coach-realtime/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
