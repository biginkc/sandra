import { expect, test } from "@playwright/test";

test("Drips sidebar wording and water drop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/brand/drips/sidebar");
  const sidebar = page.getByTestId("sidebar-crop");
  const drips = sidebar.getByRole("link", { name: "Drips" });
  await expect(drips).toHaveAttribute("href", "/sequences");
  await expect(drips).toHaveAttribute("data-active", "true");
  await expect(drips.locator("svg.lucide-droplet")).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Sequences" })).toHaveCount(0);
  await expect(sidebar).toHaveScreenshot("sidebar.png");
});
