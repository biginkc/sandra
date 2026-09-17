import fs from "node:fs";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import {
  ensureE2ERunEnvironment,
  identityForPrincipal,
} from "./src/lib/supabase/e2e-identity-guard";
import { assertSafeE2ESupabaseTargetFromEnvironment } from "./src/lib/supabase/e2e-target-safety";

/**
 * Playwright config for the Inbox acceptance harness (DoD#2, acceptance
 * matrix skeleton). Mirrors playwright.config.ts exactly, with three
 * additions to webServer.env so the new /inbox workspace routes are
 * reachable: INBOX_WORKSPACE_SERVER_ENABLED, INBOX_ACTIONS_SERVER_ENABLED,
 * INBOX_REPLIES_SERVER_ENABLED. These flags stay OFF in prod — this file
 * only turns them on for the harness's own dev server.
 *
 * Shared-fixture convention: fullyParallel:false, workers:1. The
 * acceptance suite reuses e2e/auth.setup.ts's storageState via the same
 * setup -> chromium project dependency the main suite uses.
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

for (const key of [
  "E2E_RUN_SLUG",
  "E2E_TEST_USER_EMAIL",
  "E2E_TEST_USER_PASSWORD",
] as const) {
  process.env[key] = process.env[key] ?? env[key];
}
const e2eRunEnvironment = ensureE2ERunEnvironment();
const e2ePrimaryIdentity = identityForPrincipal(e2eRunEnvironment);

const supabaseUrl =
  process.env.TEST_SUPABASE_URL ?? env.TEST_SUPABASE_URL ?? "";
const supabaseAnonKey =
  process.env.TEST_SUPABASE_ANON_KEY ?? env.TEST_SUPABASE_ANON_KEY ?? "";
const supabaseServiceRoleKey =
  process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ??
  env.TEST_SUPABASE_SERVICE_ROLE_KEY ??
  "";
const softphoneTransport =
  process.env.NEXT_PUBLIC_SOFTPHONE_TRANSPORT ??
  env.NEXT_PUBLIC_SOFTPHONE_TRANSPORT ??
  "";

if (supabaseUrl) {
  assertSafeE2ESupabaseTargetFromEnvironment(supabaseUrl);
}

process.env.TEST_SUPABASE_URL = supabaseUrl;
process.env.TEST_SUPABASE_ANON_KEY = supabaseAnonKey;
process.env.TEST_SUPABASE_SERVICE_ROLE_KEY = supabaseServiceRoleKey;
process.env.E2E_RUN_SLUG = e2ePrimaryIdentity.runSlug;
process.env.E2E_TEST_USER_EMAIL = e2ePrimaryIdentity.email;
process.env.E2E_TEST_USER_PASSWORD = e2ePrimaryIdentity.password;
process.env.E2E_QUIET_HOURS_NOW =
  process.env.E2E_QUIET_HOURS_NOW ?? "2026-05-09T16:00:00.000Z";

const browserChannel =
  process.env.PLAYWRIGHT_BROWSER_CHANNEL === "chrome" ? "chrome" : undefined;
const useWebpackDevServer = process.env.PLAYWRIGHT_WEBPACK_DEV_SERVER === "1";

const webServerEnv: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
  NEXT_PUBLIC_SOFTPHONE_TRANSPORT: softphoneTransport,
  SUPABASE_SERVICE_ROLE_KEY: supabaseServiceRoleKey,
  E2E_RUN_SLUG: e2ePrimaryIdentity.runSlug,
  E2E_TEST_USER_EMAIL: e2ePrimaryIdentity.email,
  E2E_TEST_USER_PASSWORD: e2ePrimaryIdentity.password,
  NEXT_PUBLIC_HUGO_SSO: "1",
  E2E_AUTH_BYPASS: "1",
  MESSAGING_PROVIDER: "mock",
  ADDRESS_VERIFIER_PROVIDER: "mock",
  SKIP_INTENT_GATE: "1",
  ADMIN_EMAILS: e2ePrimaryIdentity.email,
  E2E_QUIET_HOURS_NOW: process.env.E2E_QUIET_HOURS_NOW,
  NODE_ENV: "development",
  // Acceptance-harness-only: turns on the new /inbox workspace routes for
  // THIS webServer process only. Never set in prod deploy config.
  INBOX_WORKSPACE_SERVER_ENABLED: "1",
  INBOX_ACTIONS_SERVER_ENABLED: "1",
  INBOX_REPLIES_SERVER_ENABLED: "1",
};

export default defineConfig({
  testDir: "./e2e/inbox-acceptance",
  // Wraps the shared e2e/global-setup.ts (cross-run advisory lock) with
  // this harness's own start-of-run matrix reset and end-of-run matrix
  // write + fixture cleanup — see that file for why both live in one
  // globalSetup rather than a separate globalTeardown.
  globalSetup: "./e2e/inbox-acceptance/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    // Must match e2e/auth.setup.ts's hardcoded cookie origin
    // ("http://localhost:3456") exactly, or the reused storageState cookies
    // land on the wrong origin and every authenticated request 401s.
    baseURL: "http://localhost:3456",
    ...(browserChannel ? { channel: browserChannel } : {}),
    // Astra round-2 finding #1: a PASSING row's Evidence cell must link a
    // real run artifact, not just name the spec file. Astra offered two
    // options — trace:"on" globally, OR an explicit screenshot/attachment
    // per passing row. We use the second: captureRowEvidence() (results.ts)
    // takes an explicit page.screenshot() at the moment each row's
    // assertion passes, saved under test-results/inbox-acceptance-evidence/
    // and linked from the matrix. trace:"on" was tried first but reliably
    // hung this suite's browser.close() for the full 30s test timeout
    // (reproduced in isolation on just the auth.setup project) — a known
    // cost of always-on tracing colliding with this project's explicit
    // per-test screenshot calls, not something to carry given the explicit
    // per-row screenshot already satisfies the requirement.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testDir: "./e2e",
      testMatch: /auth\.setup\.ts$/,
      // Same exclusions as playwright.config.ts's top-level testIgnore:
      // don't pick up the prod-canary / properties-filter setup files,
      // which need creds and fixtures this harness doesn't have.
      testIgnore: ["**/prod-canary/**", "**/properties-filter-characterization.*.ts"],
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
    // Same port as the main e2e suite (3456): auth.setup.ts hardcodes that
    // origin when seeding cookies into storageState, and the fixture
    // serialization rule in this harness already means it never runs
    // concurrently with the main suite against the same shared fixture.
    command: useWebpackDevServer
      ? "npx next dev --webpack -p 3456"
      : "npx next dev -p 3456",
    url: "http://localhost:3456/login",
    reuseExistingServer: false,
    stdout: "pipe",
    timeout: 120_000,
    env: webServerEnv,
  },
});
