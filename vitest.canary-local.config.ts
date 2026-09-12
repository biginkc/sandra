import { defineConfig } from "vitest/config";
import integrationConfig from "./vitest.integration.config";

// Explicit private-loopback proof lane, never part of the hosted integration job.
if (process.env.TEST_SUPABASE_URL !== "http://127.0.0.1:54321") {
  throw new Error(
    "Local canary proofs require the private loopback API on port 54321.",
  );
}
const database = new URL(process.env.TEST_SUPABASE_DB_URL ?? "");
if (database.hostname !== "127.0.0.1" || database.port !== "54322") {
  throw new Error(
    "Local canary proofs require the private loopback database on port 54322.",
  );
}
export default defineConfig({
  ...integrationConfig,
  test: {
    ...integrationConfig.test,
    include: ["tests/local-canary/**/*.spec.ts"],
    setupFiles: ["./tests/local-canary/egress-guard.ts"],
  },
});
