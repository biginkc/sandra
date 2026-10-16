import { readdirSync } from "node:fs";
import path from "node:path";

import { defineConfig, mergeConfig } from "vitest/config";

import { replayMigrations } from "./src/lib/norma/stress/replay-migrations";
import base from "./vitest.norma-queue-stress.config";

// Stress gate against a run-owned stack that already holds the FULL current chain (see src/lib/norma/stress/setup-full-chain.ts).
const norma = replayMigrations(readdirSync(path.join(__dirname, "supabase/migrations")));
export default mergeConfig(
  base,
  defineConfig({
    test: {
      setupFiles: ["src/lib/norma/stress/setup.ts", "src/lib/norma/stress/setup-full-chain.ts"],
      env: { NORMA_STRESS_EXCLUDE_MIGRATIONS: norma.join(",") },
    },
  }),
);
