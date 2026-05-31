import { expect, test as setup } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const TARGET_LABEL = (process.env.FILTER_UI_TARGET ?? "prod").replace(
  /[^a-zA-Z0-9_-]/g,
  "-",
);
const AUTH_FILE =
  process.env.PROPERTIES_FILTER_AUTH_FILE ??
  `test-results/properties-filter-characterization/auth-${TARGET_LABEL}.json`;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value && value.length > 0) return value;
  throw new Error(
    `Missing ${name}. Run: source /tmp/sandra-prod.env before Playwright.`,
  );
}

setup("authenticate properties filter test user", async ({ page }) => {
  if (process.env.RUN_PROPERTIES_FILTER_CHARACTERIZATION !== "1") {
    throw new Error(
      "Set RUN_PROPERTIES_FILTER_CHARACTERIZATION=1 to run the properties filter characterization.",
    );
  }

  await page.goto("/login");
  await page.getByLabel("Email").fill(requiredEnv("PROD_EMAIL"));
  await page.getByLabel("Password").fill(requiredEnv("PROD_PASSWORD"));
  await page.getByRole("button", { name: /^sign in$/i }).click();

  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 30_000,
  });
  await expect(page.locator("text=Sign out")).toBeVisible();

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
