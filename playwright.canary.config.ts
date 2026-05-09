import fs from "node:fs";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * Production-grade Playwright canaries.
 *
 * These tests target the deployed Sandra app and are intentionally separate
 * from the default shared-test-project E2E suite. They should use real auth,
 * real services, and real persistence paths. They do not start a local server.
 *
 * Local usage:
 *   RUN_PROD_CANARIES=1 npm run test:e2e:prod-canary
 */

function loadEnvLocal(): void {
  const filepath = path.resolve(__dirname, ".env.local");
  if (!fs.existsSync(filepath)) return;
  for (const line of fs.readFileSync(filepath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvLocal();

export default defineConfig({
  testDir: "./e2e/prod-canary",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.PROD_BASE_URL ?? "https://sandra-sooty.vercel.app",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts$/,
    },
    {
      name: "chromium",
      testIgnore: /auth\.setup\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/prod-canary.json",
      },
      dependencies: ["setup"],
    },
  ],
});
