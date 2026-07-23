import { expect, test as setup } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { assertExpectedSandraUser } from "./hugo-auth-state";

const TARGET_LABEL = (process.env.FILTER_UI_TARGET ?? "prod").replace(
  /[^a-zA-Z0-9_-]/g,
  "-",
);
const AUTH_FILE =
  process.env.PROPERTIES_FILTER_AUTH_FILE ??
  `test-results/properties-filter-characterization/auth-${TARGET_LABEL}.json`;

setup("authenticate properties filter test user", async ({ page }) => {
  if (process.env.RUN_PROPERTIES_FILTER_CHARACTERIZATION !== "1") {
    throw new Error(
      "Set RUN_PROPERTIES_FILTER_CHARACTERIZATION=1 to run the properties filter characterization.",
    );
  }

  await assertExpectedSandraUser(page);
  await expect(page.locator("text=Sign out")).toBeVisible();

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
