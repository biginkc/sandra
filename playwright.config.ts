import fs from "node:fs";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Sandra CRM E2E safety net (Feature 9).
 *
 * These tests run against the `sandra-crm-test` Supabase project — same
 * project as the integration tests — but boot the real Next dev server
 * (webServer below) so the browser exercises the full stack including
 * client React, dropdown menus, and auth cookies.
 *
 * To run locally:  `npm run test:e2e`
 * In GitHub Actions: `.github/workflows/e2e.yml` loads secrets into env
 * and runs the same command.
 */

function loadTestEnv(): Record<string, string> {
  const filepath = path.resolve(__dirname, ".env.test.local");
  if (!fs.existsSync(filepath)) return {};
  const raw = fs.readFileSync(filepath, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = loadTestEnv();

// Fall back to process.env so CI can inject TEST_SUPABASE_* via secrets.
const supabaseUrl = env.TEST_SUPABASE_URL ?? process.env.TEST_SUPABASE_URL ?? "";
const supabaseAnonKey =
  env.TEST_SUPABASE_ANON_KEY ?? process.env.TEST_SUPABASE_ANON_KEY ?? "";
const supabaseServiceRoleKey =
  env.TEST_SUPABASE_SERVICE_ROLE_KEY ??
  process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ??
  "";

// Publish the values to process.env so the test workers + fixtures can
// read them. `webServer.env` already gets its own copy below.
process.env.TEST_SUPABASE_URL = supabaseUrl;
process.env.TEST_SUPABASE_ANON_KEY = supabaseAnonKey;
process.env.TEST_SUPABASE_SERVICE_ROLE_KEY = supabaseServiceRoleKey;

const webServerEnv: Record<string, string> = {
  // The Next app reads these for its Supabase clients. Point them at the
  // test project so e2e tests never touch dev data.
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
  SUPABASE_SERVICE_ROLE_KEY: supabaseServiceRoleKey,
  // Mocks match the integration-test setup — no real Dialpad / SmartyStreets.
  MESSAGING_PROVIDER: "mock",
  ADDRESS_VERIFIER_PROVIDER: "mock",
  // Pin admin email so /properties knows claude@test.com is admin for the
  // duration of the suite (enables Delete in the Actions menu tests).
  ADMIN_EMAILS: "claude@test.com,jarrad@bmhgroupkc.com",
  NODE_ENV: "development",
};

export default defineConfig({
  testDir: "./e2e",
  // Don't run in parallel — the suite resets shared DB tables. Parallel
  // specs would race each other and flake.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://localhost:3456",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts$/,
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    // Dedicated port so e2e runs don't collide with a human-run `npm run dev`.
    command: "npx next dev -p 3456",
    url: "http://localhost:3456/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: webServerEnv,
  },
});
