import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.DRIPS_BRAND_PORT ?? 3577);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/brand/drips",
  outputDir: "/private/tmp/sandra-drips-brand-playwright",
  reporter: "list",
  expect: { toHaveScreenshot: { pathTemplate: "docs/design/screenshots/drips/{arg}{ext}" } },
  use: { baseURL, ...devices["Desktop Chrome"] },
  webServer: {
    command: `pnpm exec next dev --webpack -p ${port}`,
    url: `${baseURL}/brand/drips/sidebar`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "brand-fixture-no-auth",
    },
  },
});
