import { expect, type Page } from "@playwright/test";

export async function openMenuByTestId(
  page: Page,
  triggerTestId: string,
  itemTestId: string,
): Promise<ReturnType<Page["getByTestId"]>> {
  const trigger = page.getByTestId(triggerTestId);
  const item = page.getByTestId(itemTestId);

  await expect(trigger).toBeVisible({ timeout: 10_000 });

  const openAttempts = [
    async () => trigger.click(),
    async () => {
      await page.keyboard.press("Escape");
      await trigger.focus();
      await page.keyboard.press("Enter");
    },
    async () => {
      await page.keyboard.press("Escape");
      await trigger.click({ force: true });
    },
  ];

  for (const open of openAttempts) {
    await open();
    if (await item.isVisible({ timeout: 1_500 })) {
      return item;
    }
  }

  await expect(item).toBeVisible({ timeout: 10_000 });
  return item;
}

export async function clickMenuItemByTestId(
  page: Page,
  triggerTestId: string,
  itemTestId: string,
): Promise<void> {
  const item = await openMenuByTestId(page, triggerTestId, itemTestId);
  await item.click();
}
