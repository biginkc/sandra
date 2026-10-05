import { defineConfig, devices } from "@playwright/test";

/**
 * Scripted browser-chaos lane of the chaos-day stress harness (opt-in; never a default lane).
 * Started by the engine (`e2e/stress/engine.ts`) in root's desktop context: `codex exec`'s sandbox
 * cannot launch Chromium. No improvising "chaos brain": every spec replays a recorded schedule tick.
 *
 * baseURL is the GATE PROXY in front of the app (loopback only). Rolling traces are ALWAYS on and
 * retained around every mutating tick (`trace: on`, light: no snapshots; per-tick trace files under the run dir).
 */
const proxy = process.env.STRESS_PROXY_URL ?? "";
if (process.env.STRESS_HARNESS !== "1") throw new Error("playwright.stress.config.ts is opt-in: set STRESS_HARNESS=1.");
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(proxy)) throw new Error("STRESS_PROXY_URL must be the loopback gate proxy (http://localhost:<port>).");
if (process.env.VERCEL_ENV || process.env.RUN_PROD_CANARIES === "1") throw new Error("refusing: hosted runtime or prod-canary flag set.");

export default defineConfig({
  testDir: "./e2e/stress/browser",
  testMatch: /\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0, // a mutating step is never retried; non-mutating waits retry inside the spec (max 2, logged)
  forbidOnly: true,
  reporter: "list",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: `${process.env.STRESS_RUN_DIR ?? "test-results"}/playwright`,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: proxy,
    timezoneId: "America/Chicago",
    // Always on, but LIGHT: actions, network and console only. Full snapshots of a Next dev page (every JS chunk and stylesheet, per action)
    // made each trace zip take minutes at teardown, which the 90 s teardown budget turned into a timeout on a test that had passed.
    trace: { mode: "on", snapshots: false, screenshots: false, sources: false },
    screenshot: "only-on-failure",
    video: "off",
  },
});
