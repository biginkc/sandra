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
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "server-only": path.resolve(
        __dirname,
        "./node_modules/server-only/empty.js",
      ),
    },
  },
});
