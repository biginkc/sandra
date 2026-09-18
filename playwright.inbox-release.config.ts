import { defineConfig, devices } from "@playwright/test";

// Release acceptance is pointed at the separately owned local HTTP fixture.
// Keep both endpoint guards exact: changing either port can silently retarget
// a shared stack or a remote service.
const supabaseUrl =
  process.env.INBOX_RELEASE_SUPABASE_URL ?? "http://127.0.0.1:54321";
const databaseUrl =
  process.env.INBOX_RELEASE_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const expectedUrl = "http://127.0.0.1:54321";
const expectedDatabase =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (supabaseUrl !== expectedUrl) {
  throw new Error(
    `Inbox release E2E requires ${expectedUrl}; refusing ${supabaseUrl}.`,
  );
}
if (databaseUrl !== expectedDatabase) {
  throw new Error(
    `Inbox release E2E requires the owned local DB DSN; refusing ${databaseUrl}.`,
  );
}

const anonKey = process.env.INBOX_RELEASE_ANON_KEY ?? process.env.TEST_SUPABASE_ANON_KEY ?? "";
const serviceRoleKey =
  process.env.INBOX_RELEASE_SERVICE_ROLE_KEY ??
  process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ??
  "";
if (!anonKey || !serviceRoleKey) {
  throw new Error(
    "Inbox release E2E requires explicit anon and service-role keys from the owned fixture.",
  );
}

const appBaseURL = process.env.INBOX_RELEASE_APP_BASE_URL ?? "http://localhost:3456";
const appURL = new URL(appBaseURL);
if (
  appURL.protocol !== "http:" ||
  !["localhost", "127.0.0.1"].includes(appURL.hostname)
) {
  throw new Error("Inbox release E2E app target must be a local HTTP URL.");
}

export default defineConfig({
  testDir: "./e2e/inbox-acceptance",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: appBaseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npx next dev -p 3456",
    url: `${appBaseURL}/login`,
    reuseExistingServer: false,
    stdout: "pipe",
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      TEST_SUPABASE_URL: supabaseUrl,
      TEST_SUPABASE_ANON_KEY: anonKey,
      TEST_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      INBOX_WORKSPACE_SERVER_ENABLED: "1",
      INBOX_ACTIONS_SERVER_ENABLED: "1",
      INBOX_REPLIES_SERVER_ENABLED: "1",
      MESSAGING_PROVIDER: "mock",
      ADDRESS_VERIFIER_PROVIDER: "mock",
      NODE_ENV: "development",
    },
  },
});
