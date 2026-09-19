import { defineConfig } from "vitest/config";
import integration from "./vitest.integration.config";

if (process.env.TEST_SUPABASE_URL !== "http://127.0.0.1:54321" ||
    process.env.TEST_SUPABASE_DB_URL !== "postgresql://postgres:postgres@127.0.0.1:54322/postgres") {
  throw new Error("Disposable canaries require the runner-owned loopback stack");
}

export default defineConfig({
  ...integration,
  test: {
    ...integration.test,
    include: [
      "src/lib/ai-responder/dispatch.integration.test.ts",
      "src/app/api/webhooks/sendillo/sms/route.integration.test.ts",
      "src/app/api/webhooks/dialpad/sms/route.integration.test.ts",
      "src/app/api/cron/sequence-tick/route.integration.test.ts",
      "src/app/api/cron/sequence-tick/route.queue.integration.test.ts",
    ],
    setupFiles: ["./tests/disposable-canary/network-guard.ts"],
  },
});
