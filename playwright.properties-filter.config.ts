import { defineConfig, devices } from "@playwright/test";

const baseURL =
  process.env.FILTER_UI_BASE_URL ??
  process.env.PROD_BASE_URL ??
  "https://sandra-sooty.vercel.app";
const targetLabel = (process.env.FILTER_UI_TARGET ?? "prod").replace(
  /[^a-zA-Z0-9_-]/g,
  "-",
);
const authFile =
  process.env.PROPERTIES_FILTER_AUTH_FILE ??
  `test-results/properties-filter-characterization/auth-${targetLabel}.json`;
const timeout = Number(process.env.PROPERTIES_FILTER_TEST_TIMEOUT_MS ?? 600_000);

export default defineConfig({
  testDir: "./e2e",
  testMatch: [
    /properties-filter-characterization\.auth\.setup\.ts$/,
    /properties-filter-characterization\.spec\.ts$/,
  ],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : "list",
  timeout,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: process.env.FILTER_UI_TRACE === "1" ? "retain-on-failure" : "off",
    screenshot: process.env.FILTER_UI_SCREENSHOT === "1" ? "only-on-failure" : "off",
    viewport: { width: 1440, height: 900 },
  },
  outputDir: "test-results/properties-filter-characterization/artifacts",
  projects: [
    {
      name: "setup",
      testMatch: /properties-filter-characterization\.auth\.setup\.ts$/,
    },
    {
      name: "chromium",
      testMatch: /properties-filter-characterization\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: authFile,
      },
      dependencies: ["setup"],
    },
  ],
});
