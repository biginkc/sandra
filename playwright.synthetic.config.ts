import { defineConfig, devices } from "@playwright/test";

/**
 * Database-free browser contract proofs. These specs render synthetic records
 * directly in Chrome and never start Sandra or connect to Supabase.
 */
export default defineConfig({
  testDir: "./e2e/synthetic",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    ...devices["Desktop Chrome"],
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL === "chrome" ? "chrome" : undefined,
    trace: "retain-on-failure",
  },
});
