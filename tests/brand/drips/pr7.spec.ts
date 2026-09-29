import { expect, test } from "@playwright/test";

test("PR-7 editor fixture matches reviewed baseline", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1120 });
  await page.goto("/brand/drips/editor", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Quiet owner check-in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save all steps" })).toHaveCount(1);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page).toHaveScreenshot("editor.png", { fullPage: true, animations: "disabled" });
});

test("PR-7 saved new drip opens with one blank step", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1120 });
  await page.goto("/brand/drips/editor-new", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /^Step 1$/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Step 2$/ })).toHaveCount(0);
  await expect(page).toHaveScreenshot("editor-new.png", { fullPage: true, animations: "disabled" });
});
