import { expect, type Page } from "@playwright/test";

export async function clickMenuItemByTestId(
  page: Page,
  triggerTestId: string,
  itemTestId: string,
): Promise<void> {
  await page.getByTestId(triggerTestId).click();
  const item = page.getByTestId(itemTestId);
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();
}
