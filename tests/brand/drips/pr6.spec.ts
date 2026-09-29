import { expect, test } from "@playwright/test";

for (const [route, screenshot, title] of [
  ["detail", "detail.png", "Quiet owner check-in"],
  ["detail-states", "detail-states.png", "Dead lead requalify"],
  ["detail-ready", "detail-ready.png", "First touch new lead"],
  ["detail-error", "detail-error.png", "Drip unavailable"],
] as const) {
  test(`PR-6 ${route} fixture`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 1120 });
    await page.goto(`/brand/drips/${route}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page).toHaveScreenshot(screenshot, { fullPage: true, animations: "disabled" });
  });
}
