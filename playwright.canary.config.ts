import { defineConfig, devices } from "@playwright/test";
import { requireHugoAuthStorageState } from "./e2e/hugo-auth-state";
import {
  DEFAULT_PROD_BASE_URL,
  loadProdCanaryEnvFiles,
} from "./src/lib/prod-canary/env";

/**
 * Production-grade Playwright canaries.
 *
 * These tests target the deployed Sandra app and are intentionally separate
 * from the default shared-test-project E2E suite. They should use real auth,
 * real services, and real persistence paths. They do not start a local server.
 *
 * Local usage:
 *   RUN_PROD_CANARIES=1 npm run test:e2e:prod-canary
 *
 * Local env files are loaded in priority order:
 *   1. .env.prod-canary.local
 *   2. .env.local
 *
 * Shell environment variables still take precedence over both files.
 */

loadProdCanaryEnvFiles(__dirname);
const baseURL = process.env.PROD_BASE_URL ?? DEFAULT_PROD_BASE_URL;
// A fresh Hugo login is required for unattended cloud runs. A pre-captured
// storage state remains available for local, read-only diagnostics.
const hugoAuthStorageState = process.env.PROD_HUGO_STORAGE_STATE
  ? requireHugoAuthStorageState("PROD_HUGO_STORAGE_STATE", baseURL)
  : undefined;

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
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts$/,
      use: hugoAuthStorageState ? { storageState: hugoAuthStorageState } : {},
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
