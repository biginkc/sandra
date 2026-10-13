import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.norma-queue.config";

// Full-chain run-owned stack (every migration, including the queue ones, already applied): the queue fixture runs in "applied mode"
// (tests/integration/norma-queue-fixture.ts). The 6 "pre-migration rows" tests need a database WITHOUT the queue migrations and run
// separately: see vitest.norma-queue-prequeue.config.ts.
export default mergeConfig(base, defineConfig({ test: { testNamePattern: "^(?!pre-migration rows seeded before the queue migration)" } }));
