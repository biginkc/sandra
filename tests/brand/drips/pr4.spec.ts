import path from "node:path";
import { expect, test } from "@playwright/test";

const screens = [
  { route: "lead-page", file: "LeadPage.png", check: "lead-drip-card" },
  { route: "lead-page-no-drip", file: "LeadPage-NoDrip.png", check: "lead-drip-card" },
  { route: "leads-board", file: "LeadsBoard.png", check: "lead-drip-chip-brand-lead" },
] as const;

for (const screen of screens) test(`PR-4 ${screen.route} fixture`, async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/brand/drips/${screen.route}`, { timeout: 300_000 });
  await expect(page.getByTestId(screen.check).first()).toBeVisible();
  if (screen.route === "leads-board") {
    await expect(async () => {
      if (await page.getByText("1 selected").count() === 0) await page.getByRole("checkbox", { name: "Select 12 Oak Hill Cluster" }).click();
      await expect(page.getByText("1 selected")).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
  }
  await page.screenshot({ path: path.resolve("docs/design/screenshots/drips", screen.file), fullPage: true });
});
