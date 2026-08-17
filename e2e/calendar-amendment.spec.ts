import { expect, test } from "@playwright/test";

import { adminClient, ensureTestUser, resetTenantTables } from "./fixtures";

test.describe("Calendar Phase 1 amendment", () => {
  test("Month prev/next retain an independent anchor and Today resets both", async ({
    page,
  }) => {
    const admin = adminClient();
    await resetTenantTables(admin);
    await ensureTestUser(admin);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      "/calendar?view=month&week=2040-06-10&month=2040-01&assignee=all",
    );

    await expect(page.getByTestId("calendar-range-label")).toHaveText(
      "January 2040",
    );
    await expect(page.getByTestId("calendar-month-grid")).toBeVisible();
    await expect(
      page.locator('[data-testid^="calendar-month-cell-"]'),
    ).toHaveCount(42);
    await expect(page.getByTestId("calendar-empty-range-notice")).toHaveText(
      "Nothing scheduled in this period.",
    );
    await expect(
      page.locator('[data-testid^="calendar-month-cell-"][data-today="true"]'),
    ).toHaveCount(0);

    const previous = page.getByTestId("calendar-prev");
    const next = page.getByTestId("calendar-next");
    const today = page.getByTestId("calendar-today");
    await expect(previous).toHaveAttribute("aria-label", "Previous period");
    await expect(next).toHaveAttribute("aria-label", "Next period");

    await previous.click();
    await expect(page).toHaveURL(/month=2039-12/);
    await expect(page).toHaveURL(/week=2040-06-10/);
    await expect(page.getByTestId("calendar-range-label")).toHaveText(
      "December 2039",
    );

    await next.click();
    await expect(page).toHaveURL(/month=2040-01/);
    await expect(page.getByTestId("calendar-range-label")).toHaveText(
      "January 2040",
    );

    await next.click();
    await expect(page).toHaveURL(/month=2040-02/);
    await expect(page.getByTestId("calendar-range-label")).toHaveText(
      "February 2040",
    );
    await expect(today).toHaveClass(/bg-foreground/);

    await today.click();
    await expect(page).not.toHaveURL(/[?&](?:month|week)=/);
    await expect(page.getByTestId("calendar-today")).toHaveClass(/bg-card/);
    await expect(
      page.locator('[data-testid^="calendar-month-cell-"]'),
    ).toHaveCount(42);
  });
});
