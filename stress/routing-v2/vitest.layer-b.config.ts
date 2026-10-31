import path from "node:path";
import { defineConfig } from "vitest/config";

/** Stress Layer B: pure precedence / band / Haiku-outcome / fault fixtures. No network, no DB. */
const root = path.resolve(__dirname, "../..");
export default defineConfig({
  root,
  test: {
    include: ["stress/routing-v2/layer-b/**/*.test.ts"],
    environment: "node",
    reporters: ["verbose"],
  },
  resolve: {
    alias: {
      "@": path.resolve(root, "./src"),
      "server-only": path.resolve(root, "./node_modules/server-only/empty.js"),
    },
  },
});
