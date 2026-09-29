import { expect, test } from "@playwright/test";

test("Messages shows drip attribution and reply", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/brand/drips/messages");
  await expect(page.getByTestId("inbox-detail-drip-line")).toContainText("Was in Quiet owner check-in");
  await expect(page.getByTestId("messages-thread-drip-label")).toHaveCount(2);
  await expect(page.getByTestId("messages-thread-drip-reply")).toHaveCount(1);
  await expect(page).toHaveScreenshot("messages-first-text.png");
  await page.getByTestId("inbox-detail-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page).toHaveScreenshot("messages.png");
});

test("Messages explains why a saved outcome could not start a drip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/brand/drips/cant-start");
  await expect(page.getByTestId("drip-cant-start")).toContainText("The outcome was saved. Already in Current seller check-in, text 1 of 3.");
  await expect(page.getByRole("button", { name: "Switch to this drip" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open lead" })).toBeVisible();
  await expect(page).toHaveScreenshot("cant-start.png");
});
