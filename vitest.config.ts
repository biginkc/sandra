import { defineConfig } from "vitest/config";
import path from "node:path";

// Default (unit) suite. Integration tests live under `*.integration.test.ts`
// and are run via `vitest.integration.config.ts` / `npm run test:integration`
// so they don't touch the fast-path used by the husky pre-commit hook.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "node_modules/**"],
    environment: "node",
    reporters: ["default"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
