import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.norma-queue.config";

// Pre-queue run: ONLY the 6 tests that seed rows before the queue migration ([E3], [F3], [G1]).
// Needs a run-owned stack built from the chain WITHOUT 20261009010000/20261009010100 (e.g. provision-stack.mjs from a checkout of main).
//   TEST_SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:<db-port>/postgres npx vitest run --config vitest.norma-queue-prequeue.config.ts
export default mergeConfig(base, defineConfig({ test: { testNamePattern: "^pre-migration rows seeded before the queue migration" } }));
