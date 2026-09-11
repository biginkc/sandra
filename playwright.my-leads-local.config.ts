import { defineConfig, devices } from "@playwright/test"

/**
 * Local, fixture-backed My Leads acceptance lane.
 *
 * The app and Supabase runtime are started by the acceptance owner. This
 * config deliberately has no global setup, web server, storage state, trace,
 * screenshot, video, or fixture provisioning hook.
 */
const baseURL =
  process.env.MY_LEADS_LOCAL_BASE_URL ?? "http://127.0.0.1:58700"
const appURL = new URL(baseURL)
if (
  appURL.protocol !== "http:" ||
  appURL.hostname !== "127.0.0.1" ||
  appURL.port !== "58700"
) {
  throw new Error("My Leads local acceptance may target only http://127.0.0.1:58700.")
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: /my-leads\.local\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    timezoneId: "America/Chicago",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
})
