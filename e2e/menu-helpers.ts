import { expect, type Page } from "@playwright/test";

export async function openMenuByTestId(
  page: Page,
  triggerTestId: string,
  itemTestId: string,
): Promise<ReturnType<Page["getByTestId"]>> {
  const trigger = page.getByTestId(triggerTestId);
  const item = page.getByTestId(itemTestId);

  await expect(trigger).toBeVisible({ timeout: 10_000 });
  // Base UI installs aria-expanded when the menu trigger is initialized. Wait
  // for that contract before the single click so a visible, pre-initialized
  // trigger cannot lose the opening action.
  await expect(trigger).toHaveAttribute("aria-expanded", /^(false|true)$/);

  // isVisible() does not wait, even when passed a timeout. Repeated trigger
  // actions can close a menu whose opening animation is still in progress.
  await trigger.click();
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
