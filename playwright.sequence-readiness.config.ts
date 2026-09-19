import { randomBytes } from "node:crypto";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import {
  ensureE2ERunEnvironment,
  identityForPrincipal,
} from "./src/lib/supabase/e2e-identity-guard";

const baseURL =
  process.env.SEQUENCE_READINESS_BASE_URL ?? "http://127.0.0.1:3557";
const appURL = new URL(baseURL);
if (
  appURL.protocol !== "http:" ||
  appURL.hostname !== "127.0.0.1" ||
  appURL.port !== "3557"
) {
  throw new Error(
    "Sequence readiness browser tests may target only http://127.0.0.1:3557.",
  );
}

const ledgerBaseURL =
  process.env.SEQUENCE_READINESS_LEDGER_URL ?? "http://127.0.0.1:3558/ledger";
const ledgerURL = new URL(ledgerBaseURL);
if (
  ledgerURL.protocol !== "http:" ||
  ledgerURL.hostname !== "127.0.0.1" ||
  ledgerURL.port !== "3558" ||
  ledgerURL.pathname !== "/ledger"
) {
  throw new Error(
    "Sequence readiness ledger must use http://127.0.0.1:3558/ledger.",
  );
}

const localSupabaseURL = "http://127.0.0.1:54321";
const localSupabaseDbURL =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (process.env.E2E_DISPOSABLE_DATABASE !== "1") {
  throw new Error("Sequence readiness browser tests require E2E_DISPOSABLE_DATABASE=1.");
}
if (process.env.TEST_SUPABASE_URL !== localSupabaseURL) {
  throw new Error("Sequence readiness browser tests require the local Supabase API.");
}
if (process.env.TEST_SUPABASE_DB_URL !== localSupabaseDbURL) {
  throw new Error("Sequence readiness browser tests require the local Supabase database.");
}
for (const name of ["TEST_SUPABASE_ANON_KEY", "TEST_SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!process.env[name]) throw new Error(`${name} is required for local browser tests.`);
}

const run = ensureE2ERunEnvironment();
const identity = identityForPrincipal(run);
const ledgerToken =
  process.env.SEQUENCE_READINESS_LEDGER_TOKEN ?? randomBytes(24).toString("base64url");
if (ledgerToken.length < 16) {
  throw new Error("SEQUENCE_READINESS_LEDGER_TOKEN must be at least 16 characters.");
}
// Playwright workers and the web servers both need the same generated token;
// keep it in the process environment too without ever printing it.
process.env.SEQUENCE_READINESS_LEDGER_TOKEN = ledgerToken;
process.env.SEQUENCE_READINESS_LEDGER_URL = ledgerBaseURL;
process.env.MESSAGING_PROVIDER = "mock";
process.env.SEQUENCE_READINESS_MOCK_PROVIDER_LEDGER = "1";
process.env.CRON_SECRET = "sequence-readiness-local-cron";
process.env.E2E_DISPOSABLE_DATABASE = "1";
process.env.E2E_ALLOW_LOCAL_SUPABASE = "1";
process.env.E2E_CI_SUPABASE_DB_URL = localSupabaseDbURL;
delete process.env.E2E_CI_SUPABASE_PROJECT_REF;

// Deliberately construct a small child environment instead of forwarding the
// shell environment, which may contain hosted Supabase/provider credentials.
const safeParentEnv = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "CI", "GITHUB_ACTIONS"].flatMap((name) =>
    process.env[name] ? [[name, process.env[name]]] : [],
  ),
);
const guardPath = path.resolve(
  "tests/sequence-readiness/deny-external-http.cjs",
);
const googleFontMockPath = path.resolve(
  "tests/sequence-readiness/google-fonts-mock.cjs",
);
const guardNodeOption = `--require=${JSON.stringify(guardPath)}`;
const commonLocalEnv = {
  ...safeParentEnv,
  NODE_ENV: "development",
  E2E_DISPOSABLE_DATABASE: "1",
  E2E_RUN_SLUG: identity.runSlug,
  E2E_TEST_USER_EMAIL: identity.email,
  E2E_TEST_USER_PASSWORD: identity.password,
  E2E_CI_SUPABASE_DB_URL: localSupabaseDbURL,
  E2E_ALLOW_LOCAL_SUPABASE: "1",
  TEST_SUPABASE_URL: localSupabaseURL,
  TEST_SUPABASE_DB_URL: localSupabaseDbURL,
  TEST_SUPABASE_ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY!,
  TEST_SUPABASE_SERVICE_ROLE_KEY: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!,
  NEXT_PUBLIC_SUPABASE_URL: localSupabaseURL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY!,
  SUPABASE_SERVICE_ROLE_KEY: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!,
  NEXT_PUBLIC_HUGO_SSO: "0",
  E2E_AUTH_BYPASS: "1",
  E2E_QUIET_HOURS_NOW: "2026-05-09T16:00:00.000Z",
  MESSAGING_PROVIDER: "mock",
  SEQUENCE_READINESS_MOCK_PROVIDER_LEDGER: "1",
  CRON_SECRET: "sequence-readiness-local-cron",
  ADDRESS_VERIFIER_PROVIDER: "mock",
  SKIP_INTENT_GATE: "1",
  ADMIN_EMAILS: identity.email,
  SEQUENCE_READINESS_LEDGER_URL: ledgerBaseURL,
  SEQUENCE_READINESS_LEDGER_TOKEN: ledgerToken,
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: googleFontMockPath,
};
const productionLocalEnv = {
  ...commonLocalEnv,
  // Playwright merges webServer.env with its parent process. An explicit
  // empty value prevents the runner's development-only bypass from leaking
  // into this production server.
  E2E_AUTH_BYPASS: "",
  NODE_ENV: "production",
  NEXT_PUBLIC_SITE_URL: baseURL,
  NEXT_FONT_GOOGLE_TURBOPACK_MOCKED_RESPONSES: "0",
  NEXT_TELEMETRY_DISABLED: "1",
  SEQUENCE_READINESS_PRODUCTION_BROWSER: "1",
};
const browserChannel =
  process.env.PLAYWRIGHT_BROWSER_CHANNEL === "chrome" ? "chrome" : undefined;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /sequence-readiness\.local\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: "test-results/sequence-readiness",
  use: {
    ...devices["Desktop Chrome"],
    ...(browserChannel ? { channel: browserChannel } : {}),
    baseURL,
    timezoneId: "America/Chicago",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "node tests/sequence-readiness/mock-provider-ledger.mjs",
      url: "http://127.0.0.1:3558/health",
      name: "sequence-readiness-ledger",
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        ...commonLocalEnv,
        SEQUENCE_READINESS_LEDGER_PORT: "3558",
      },
    },
    {
      command: "node tests/sequence-readiness/external-http-probe.mjs",
      url: "http://127.0.0.1:3559/health",
      name: "sequence-readiness-egress-probe",
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        ...commonLocalEnv,
        NODE_OPTIONS: guardNodeOption,
        SEQUENCE_READINESS_PROCESS_LABEL: "sequence-readiness-probe",
        SEQUENCE_READINESS_PROBE_PORT: "3559",
      },
    },
    {
      // Build once before browser workers start so cold route compilation is
      // outside the bounded acceptance-flow budgets. CI checks this real
      // production server with the offline Google-font fixture. Pin Webpack
      // because disposable mutation worktrees may symlink dependencies beyond
      // the project root, which Turbopack rejects.
      command:
        "npm run build -- --webpack && npx next start --hostname 127.0.0.1 -p 3557",
      url: `${baseURL}/login`,
      name: "sequence-readiness-app",
      timeout: 300_000,
      reuseExistingServer: false,
      env: {
        ...productionLocalEnv,
        NODE_OPTIONS: guardNodeOption,
        SEQUENCE_READINESS_PROCESS_LABEL: "sequence-readiness-app",
        PORT: "3557",
      },
    },
  ],
});
