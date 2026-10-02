import path from "node:path";

import { defineConfig } from "vitest/config";

import { assertLocalOnlyEnvironment } from "./src/lib/testing/local-only-guard";

/**
 * Opt-in runner for the SEARCH volume gate (stress plan #9, Search page) against
 * a DISPOSABLE local Supabase stack (never the shared hosted test project).
 * The ports/keys default to the throwaway stack described in
 * scripts/search-volume (a private `supabase start` stack, never 54329/hosted). Keys below are the public Supabase local-dev demo keys.
 *
 *   SEARCH_VOLUME=1 npx vitest run --config vitest.search-volume.config.ts
 */
const dbUrl = process.env.FILTER_LOCAL_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:55329/postgres";
const apiUrl = process.env.FILTER_LOCAL_API_URL ?? "http://127.0.0.1:55331";
assertLocalOnlyEnvironment({ TEST_SUPABASE_URL: apiUrl, TEST_SUPABASE_DB_URL: dbUrl });

export default defineConfig({
  test: {
    include: [
      "scripts/search-volume/search-volume.volume.test.ts",
    ],
    environment: "node",
    reporters: ["default"],
    testTimeout: 300_000,
    hookTimeout: 900_000,
    fileParallelism: false,
    env: {
      TEST_SUPABASE_URL: apiUrl,
      TEST_SUPABASE_ANON_KEY:
        process.env.FILTER_LOCAL_ANON_KEY ??
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
      TEST_SUPABASE_SERVICE_ROLE_KEY:
        process.env.FILTER_LOCAL_SERVICE_KEY ??
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
      TEST_SUPABASE_DB_URL: dbUrl,
      FILTER_LOCAL_JWT_SECRET:
        process.env.FILTER_LOCAL_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long",
      ADDRESS_VERIFIER_PROVIDER: "mock",
      MESSAGING_PROVIDER: "mock",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@tests": path.resolve(__dirname, "./tests"),
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
});
