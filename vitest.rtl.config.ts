import { defineConfig } from "vitest/config";
import path from "node:path";

// React Testing Library suite — runs the *.test.tsx files in jsdom so we
// can render Client Components without booting Playwright. Sits alongside
// the Node-env unit suite (`vitest.config.ts`, `*.test.ts`) and the
// Postgres-backed integration suite (`vitest.integration.config.ts`,
// `*.integration.test.ts`). Run via `npm run test:rtl`.
export default defineConfig({
  test: {
    include: ["src/**/*.test.tsx"],
    exclude: ["**/*.integration.test.ts", "node_modules/**", "e2e/**"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.rtl.setup.ts"],
    reporters: ["default"],
    // Empty .tsx test set is fine on the harness commit before any tests
    // have been migrated. Once we have steady RTL coverage we can flip
    // this back to the default if we want a tripwire on accidentally
    // moving all .test.tsx files out of `src/`.
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
