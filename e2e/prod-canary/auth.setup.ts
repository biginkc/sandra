import { expect, test as setup } from "@playwright/test";

import {
  PROD_CANARY_AUTH_FILE,
  requireProdCanaryEnv,
} from "./support";
import { assertExpectedSandraUser } from "../hugo-auth-state";

setup("authenticate production canary user", async ({ page }) => {
  const env = requireProdCanaryEnv();

  if (!process.env.PROD_HUGO_STORAGE_STATE) {
    const password = process.env.PROD_PASSWORD;
    if (!password) {
      throw new Error("Set PROD_PASSWORD for unattended Hugo canary login.");
    }
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in with Hugo" }).click();
    const hugoHost = new URL(
      process.env.PROD_HUGO_URL ?? "https://hugo.bmhgroupkc.com",
    ).hostname;
    await page.waitForURL((url) => url.hostname === hugoHost, {
      timeout: 30_000,
    });
    await page.getByLabel("Email").fill(env.email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(
      (url) =>
        url.hostname === new URL(env.baseURL).hostname &&
        !url.pathname.startsWith("/login"),
      { timeout: 30_000 },
    );
  }
  await assertExpectedSandraUser(page);
  await expect(page.locator("text=Sign out")).toBeVisible();
  await expect(page.getByTitle(env.email, { exact: true })).toBeVisible();

  // Copy only the already-authenticated Hugo browser state into the suite's
  // ignored working file. The config supplies the source state to this setup.
  await page.context().storageState({ path: PROD_CANARY_AUTH_FILE });
});
