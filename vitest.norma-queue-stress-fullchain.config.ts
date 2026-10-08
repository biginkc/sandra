import { readdirSync } from "node:fs";
import path from "node:path";

import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.norma-queue-stress.config";

// Stress gate against a run-owned stack that already holds the FULL current chain (see src/lib/norma/stress/setup-full-chain.ts).
const norma = readdirSync(path.join(__dirname, "supabase/migrations")).filter((f) => /^\d{14}_norma_.+\.sql$/.test(f));
export default mergeConfig(
  base,
  defineConfig({
    test: {
      setupFiles: ["src/lib/norma/stress/setup.ts", "src/lib/norma/stress/setup-full-chain.ts"],
      env: { NORMA_STRESS_EXCLUDE_MIGRATIONS: norma.join(",") },
    },
  }),
);
