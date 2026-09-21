import { defineConfig, devices } from "@playwright/test";

/**
 * Local, fixture-backed Jev decision-workflow acceptance lane (root
 * review of 8361775a, jev-root-revision-review.md, 2026-09-20, gap 4).
 *
 * Same posture as playwright.my-leads-local.config.ts: the app and
 * Supabase runtime (this worktree's own `supabase start` stack, ports
 * 54329/54331) are started by the acceptance owner before this config
 * runs. No global setup, web server, storage state, trace, screenshot,
 * or video — the spec provisions its own fixtures directly via `pg` +
 * the Supabase Auth admin API against the local stack, and drives a
 * `next dev` already running on JEV_LOCAL_BASE_URL.
 */
const baseURL = process.env.JEV_LOCAL_BASE_URL ?? "http://127.0.0.1:58900";
const appURL = new URL(baseURL);
if (
  appURL.protocol !== "http:" ||
  appURL.hostname !== "127.0.0.1" ||
  appURL.port !== "58900"
) {
  throw new Error("Jev local acceptance may target only http://127.0.0.1:58900.");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: /jev-decision-workflow\.local\.spec\.ts$/,
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
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});
