import fs from "node:fs";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import {
  ensureE2ERunEnvironment,
  identityForPrincipal,
} from "./src/lib/supabase/e2e-identity-guard";
import { assertSafeE2ESupabaseTargetFromEnvironment } from "./src/lib/supabase/e2e-target-safety";

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

for (const key of [
  "E2E_RUN_SLUG",
  "E2E_TEST_USER_EMAIL",
  "E2E_TEST_USER_PASSWORD",
] as const) {
  process.env[key] = process.env[key] ?? env[key];
}
const e2eRunEnvironment = ensureE2ERunEnvironment();
const e2ePrimaryIdentity = identityForPrincipal(e2eRunEnvironment);

// Fall back to process.env so CI can inject TEST_SUPABASE_* via secrets.
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

// Publish the values to process.env so the test workers + fixtures can
// read them. `webServer.env` already gets its own copy below.
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
  // The Next app reads these for its Supabase clients. Point them at the
  // test project so e2e tests never touch dev data.
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
  NEXT_PUBLIC_SOFTPHONE_TRANSPORT: softphoneTransport,
  SUPABASE_SERVICE_ROLE_KEY: supabaseServiceRoleKey,
  E2E_RUN_SLUG: e2ePrimaryIdentity.runSlug,
  E2E_TEST_USER_EMAIL: e2ePrimaryIdentity.email,
  E2E_TEST_USER_PASSWORD: e2ePrimaryIdentity.password,
  NEXT_PUBLIC_HUGO_SSO: "1",
  // The broad golden-path suite seeds a test-project password session only as
  // support evidence. Production code refuses this bypass, and real Hugo
  // acceptance remains a separate Chrome gate.
  E2E_AUTH_BYPASS: "1",
  // Mocks match the integration-test setup — no real Dialpad / SmartyStreets.
  MESSAGING_PROVIDER: "mock",
  ADDRESS_VERIFIER_PROVIDER: "mock",
  // Bypass the AI intent classifier in the dialpad webhook handler. There's
  // no Anthropic key in CI, and the classifier is unit-tested directly in
  // src/lib/leads/classify-reply-intent.test.ts. Without this, the
  // sms-roundtrip auto-qualify path silently fails closed and the test
  // can't see "prospect → new_lead". Mirror of .github/workflows/e2e.yml so
  // local runs match CI.
  SKIP_INTENT_GATE: "1",
  // Grant only this run's namespaced principal the admin-only E2E paths.
  ADMIN_EMAILS: e2ePrimaryIdentity.email,
  // Pin quiet-hours checks to 11:00 AM America/Chicago so send-flow E2E
  // coverage is deterministic when the suite runs overnight.
  E2E_QUIET_HOURS_NOW: process.env.E2E_QUIET_HOURS_NOW,
  NODE_ENV: "development",
};

export default defineConfig({
  testDir: "./e2e",
  // Hold a cross-run Postgres advisory lock for the whole run so E2E runs
  // against the dedicated CI project serialize even when GitHub's
  // concurrency group can't (different branches carrying different
  // e2e.yml group strings). See e2e/global-setup.ts.
  globalSetup: "./e2e/global-setup.ts",
  // phase-1-5-uat.spec.ts is a PROD-ONLY screenshot UAT — it requires
  // PROD_EMAIL / PROD_PASSWORD and runs against sandra-sooty.vercel.app.
  // It must not run in the default CI suite (no creds → it throws in
  // beforeAll). Use playwright.prod.config.ts for that spec.
  testIgnore: [
    "**/phase-1-5-uat.spec.ts",
    "**/prod-canary/**",
    "**/synthetic/**",
    "**/properties-filter-characterization.*.ts",
  ],
  // Don't run in parallel — the suite resets shared DB tables. Parallel
  // specs would race each other and flake.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // Bumped 1→2: CI runners are noticeably slower than local. Two retries
  // catches transient flakes (slow Supabase fetch, dropdown-open races)
  // without masking real regressions — a true regression still fails 3x.
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://localhost:3456",
    ...(browserChannel ? { channel: browserChannel } : {}),
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
    command: useWebpackDevServer
      ? "npx next dev --webpack -p 3456"
      : "npx next dev -p 3456",
    url: "http://localhost:3456/login",
    // This suite resets tenant tables and exercises background work. Never
    // attach to an arbitrary process already listening on the port: it may
    // have dev/production credentials or real provider configuration.
    reuseExistingServer: false,
    timeout: 120_000,
    env: webServerEnv,
  },
});
