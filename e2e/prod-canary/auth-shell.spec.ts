import { expect, test } from "@playwright/test";

import { requireProdCanaryEnv } from "./support";

test("production canary auth shell loads core routes", async ({
  page,
}, testInfo) => {
  const env = requireProdCanaryEnv();
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await page.goto("/properties");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator("text=Sign out")).toBeVisible();
  await expect(page.getByRole("navigation")).toContainText("Prospects");

  await page.getByRole("link", { name: /^leads$/i }).click();
  await expect(page).toHaveURL(/\/leads/);
  await expect(page.locator("main")).toBeVisible();

  await page.getByRole("link", { name: /^messages$/i }).click();
  await expect(page).toHaveURL(/\/messages/);
  await expect(page.locator("main")).toBeVisible();
});
