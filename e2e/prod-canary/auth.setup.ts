import { expect, test as setup } from "@playwright/test";

import {
  PROD_CANARY_AUTH_FILE,
  requireProdCanaryEnv,
} from "./support";
import { assertExpectedSandraUser } from "../hugo-auth-state";

setup("authenticate production canary user", async ({ page }) => {
  const env = requireProdCanaryEnv();

  await assertExpectedSandraUser(page);
  await expect(page.locator("text=Sign out")).toBeVisible();
  await expect(page.getByTitle(env.email, { exact: true })).toBeVisible();

  // Copy only the already-authenticated Hugo browser state into the suite's
  // ignored working file. The config supplies the source state to this setup.
  await page.context().storageState({ path: PROD_CANARY_AUTH_FILE });
});
