import { expect, test as setup } from "@playwright/test";

import {
  PROD_CANARY_AUTH_FILE,
  requireProdCanaryEnv,
} from "./support";

setup("authenticate production canary user", async ({ page }) => {
  const env = requireProdCanaryEnv();

  await page.goto("/login");
  await page.getByLabel("Email").fill(env.email);
  await page.getByLabel("Password").fill(env.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 30_000,
  });
  await expect(page.locator("text=Sign out")).toBeVisible();

  await page.context().storageState({ path: PROD_CANARY_AUTH_FILE });
});
