import { defineConfig, devices } from "@playwright/test";

const port = 3684;
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests/brand/drips",
  outputDir: "/private/tmp/sandra-drips-brand-playwright",
  reporter: "list",
  use: { baseURL, ...devices["Desktop Chrome"] },
  webServer: {
    command: `pnpm exec next dev -p ${port}`,
    url: `${baseURL}/icon.png`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "brand-fixture-no-auth",
    },
  },
});
