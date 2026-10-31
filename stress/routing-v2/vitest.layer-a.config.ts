import path from "node:path";
import { defineConfig } from "vitest/config";

/** Stress Layer A: live Jev + Haiku runner (opt-in via RUN_LAYER_A=1). */
const root = path.resolve(__dirname, "../..");
export default defineConfig({
  root,
  test: { include: ["stress/routing-v2/layer-a/**/*.test.ts"], environment: "node", testTimeout: 6 * 3600_000 },
  resolve: {
    alias: {
      "@": path.resolve(root, "./src"),
      "server-only": path.resolve(root, "./node_modules/server-only/empty.js"),
    },
  },
});
