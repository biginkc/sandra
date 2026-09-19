import { defineConfig } from "vitest/config";
import path from "node:path";

if (process.env.TEST_SUPABASE_URL !== "http://127.0.0.1:54321" ||
    process.env.TEST_SUPABASE_DB_URL !== "postgresql://postgres:postgres@127.0.0.1:54322/postgres") {
  throw new Error("Disposable canaries require the runner-owned loopback stack");
}

export default defineConfig({
  test: {
    include: [
      "src/lib/ai-responder/dispatch.integration.test.ts",
      "src/app/api/webhooks/sendillo/sms/route.integration.test.ts",
      "src/app/api/webhooks/dialpad/sms/route.integration.test.ts",
      "src/app/api/cron/sequence-tick/route.integration.test.ts",
      "src/app/api/cron/sequence-tick/route.queue.integration.test.ts",
      "src/lib/sequences/enrollment.integration.test.ts",
      "src/lib/sequences/starter-library.integration.test.ts",
      "src/lib/sequences/simulation.integration.test.ts",
      "src/lib/sequences/reliability.integration.test.ts",
      "src/lib/sequences/scheduling-reliability.integration.test.ts",
      "src/lib/sequences/recovery-security.integration.test.ts",
      "src/lib/messaging/send.integration.test.ts",
      "src/workflows/csv-import.enroll.integration.test.ts",
      "tests/disposable-canary/network-guard.test.ts",
    ],
    environment: "node",
    reporters: ["default"],
    // The stack is unique to this runner, so the hosted-suite advisory lock
    // and its .env.test.local loader are intentionally not imported.
    testTimeout: 30000,
    fileParallelism: false,
    env: {
      TEST_SUPABASE_URL: process.env.TEST_SUPABASE_URL ?? "",
      TEST_SUPABASE_ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY ?? "",
      TEST_SUPABASE_SERVICE_ROLE_KEY: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? "",
      TEST_SUPABASE_DB_URL: process.env.TEST_SUPABASE_DB_URL ?? "",
      ADDRESS_VERIFIER_PROVIDER: "mock",
      MESSAGING_PROVIDER: "mock",
      SKIP_TRACE_PROVIDER: "mock",
    },
    setupFiles: ["./tests/disposable-canary/network-guard.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@tests": path.resolve(__dirname, "./tests"),
      "server-only": path.resolve(
        __dirname,
        "./node_modules/server-only/empty.js",
      ),
    },
  },
});
