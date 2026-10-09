import { defineConfig, devices } from "@playwright/test";

/**
 * Local, fixture-backed Jev decision-workflow acceptance lane (root
 * review of 8361775a, jev-root-revision-review.md, 2026-09-20, gap 4).
 *
 * Same posture as playwright.my-leads-local.config.ts: the app and
 * Supabase runtime (this worktree's own `supabase start` stack, ports
 * 54329/54331) are started by the acceptance owner before this config
 * runs. No global setup, web server, storage state, trace, screenshot,
 * or video — the spec provisions its own fixtures directly via `pg`
 * (never the Admin API — see e2e-identity-contract.test.ts) against the
 * local stack, and drives a `next dev` already running on
 * JEV_LOCAL_BASE_URL.
 *
 * MUST be http://localhost:3000, not an arbitrary host:port. Root cause
 * of an earlier round's "client never hydrates, zero errors" finding:
 * next.config.ts's serverActions.allowedOrigins is
 * ["sandra.bmhgroup.com", "localhost:3000"] — Next dev's Turbopack HMR
 * WebSocket (and with it, the client runtime's interactive-ready signal)
 * also validates against this origin allowlist. 127.0.0.1:58900 matched
 * neither, so the HMR socket handshake failed every time
 * (net::ERR_INVALID_HTTP_RESPONSE) and the client bundle loaded/rendered
 * (SSR content visible) but never finished attaching React's event
 * delegation — every onClick/onChange was silently inert, with zero
 * console/hydration errors. Confirmed root cause, not just a guess: a
 * bare diagnostic spec against http://localhost:3000 logged "[HMR]
 * connected" and a plain link click (Sign out) navigated correctly.
 */
const baseURL = process.env.JEV_LOCAL_BASE_URL ?? "http://localhost:3000";
const appURL = new URL(baseURL);
if (
  appURL.protocol !== "http:" ||
  appURL.hostname !== "localhost" ||
  appURL.port !== "3000"
) {
  throw new Error("Jev local acceptance may target only http://localhost:3000 (must match next.config.ts's serverActions.allowedOrigins).");
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
