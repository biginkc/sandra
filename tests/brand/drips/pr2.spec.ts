import { expect, test } from "@playwright/test";

for (const [route, file, title] of [
  ["list", "list.png", "Drips"],
  ["list-states", "list-states.png", "Drips"],
  ["needs-person", "needs-person.png", "Needs a person"],
] as const) {
  test(`PR-2 ${route} fixture`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 1120 });
    await page.goto(`/brand/drips/${route}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page).toHaveScreenshot(file, { fullPage: true, animations: "disabled" });
  });
}
