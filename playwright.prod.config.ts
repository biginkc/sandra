import fs from "node:fs";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * Minimal Playwright config for prod visual UAT runs.
 * Points at the live prod URL — no webServer, no test DB, no seeding.
 *
 * Add to .env.local (gitignored):
 *   PROD_EMAIL=you@example.com
 *   PROD_HUGO_STORAGE_STATE=/absolute/path/to/sandra-hugo-state.json
 *
 * Then run:
 *   npx playwright test e2e/phase-1-5-uat.spec.ts \
 *     --config playwright.prod.config.ts --headed --slow-mo=600
 */

// Load .env.local so the ignored Hugo storage-state path is available
// without needing to type them in the terminal.
function loadEnvLocal() {
  const filepath = path.resolve(__dirname, ".env.local");
  if (!fs.existsSync(filepath)) return;
  for (const line of fs.readFileSync(filepath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvLocal();
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "https://sandra.bmhgroupkc.com",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
    launchOptions: { slowMo: 600 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // No webServer — prod is already running.
});
