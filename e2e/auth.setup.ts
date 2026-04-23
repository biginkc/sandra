import { test as setup, expect } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  TEST_USER_EMAIL,
  TEST_USER_PASSWORD,
} from "./fixtures";

const AUTH_FILE = "e2e/.auth/user.json";

/**
 * One-time auth setup: ensure the test user exists, sign in through the
 * real UI, and save cookies to a storage state file. Every other spec
 * reuses that state via the `chromium` project's `storageState` option,
 * so individual tests skip the login flow.
 */
setup("authenticate", async ({ page }) => {
  const admin = adminClient();
  await ensureTestUser(admin);

  await page.goto("/login");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Password").fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  // Sign-in redirects to /leads by default, or /properties if that's the
  // `next` param — we only care that we left /login.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
  await expect(page.locator("text=Sign out")).toBeVisible();

  await page.context().storageState({ path: AUTH_FILE });
});
