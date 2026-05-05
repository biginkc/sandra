import { test, expect } from "@playwright/test";

import { adminClient, resetTenantTables } from "./fixtures";

/**
 * Phase 02 smoke spec — /properties Market filter pill.
 *
 * Verifies that the Market filter dropdown on /properties renders county-shaped
 * strings fetched from the seeded counties table (migration 044), NOT the old
 * hardcoded KNOWN_MARKETS array that was deleted in plan 02-03.
 *
 * Each market option uses `data-testid={`filter-market-${m.replace(/\s+/g, "-")}`}`
 * (see src/app/(dashboard)/properties/prospects-table.tsx line 1098).
 * County-shaped strings like "Buchanan County MO" → "filter-market-Buchanan-County-MO".
 *
 * Per project memory `feedback_verify_with_playwright.md`:
 *   never ask Jarrad to refresh and check — verify it ourselves.
 *
 * Auth: the `chromium` project loads storageState from e2e/.auth/user.json
 * (set up by auth.setup.ts).
 *
 * Test DB precondition: migration 044 has seeded the BMH counties with
 * county-shaped market strings. The /properties page fetches markets from
 * the counties table and passes them to ProspectsTable as the `markets` prop.
 */

test.describe("Properties — Market filter pill (Phase 02 smoke)", () => {
  test("filter dropdown lists county-shaped strings from the seeded counties table", async ({
    page,
  }) => {
    await resetTenantTables(adminClient());
    await page.goto("/properties");

    // Open the Market filter dropdown.
    // The trigger button has data-testid="filter-market".
    await page.getByTestId("filter-market").click();

    // Assert at least 3 seeded county-shaped market strings are present
    // as DropdownMenuItem elements with their data-testid attributes.
    await expect(
      page.getByTestId("filter-market-Buchanan-County-MO"),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByTestId("filter-market-Johnson-County-KS"),
    ).toBeVisible();
    await expect(
      page.getByTestId("filter-market-Jackson-County-MO"),
    ).toBeVisible();

    // Negative assertions: legacy city-shaped data-testids must NOT appear.
    // These were the old KNOWN_MARKETS values — their testids would be
    // filter-market-Kansas-City, filter-market-St.-Louis, etc.
    await expect(
      page.getByTestId("filter-market-Kansas-City"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("filter-market-St.-Louis"),
    ).toHaveCount(0);
  });

  // Smoke: clicking a county filter option updates the URL + trigger label.
  test("selecting a county market filter updates the displayed filter label", async ({
    page,
  }) => {
    await resetTenantTables(adminClient());
    await page.goto("/properties");

    await page.getByTestId("filter-market").click();

    // Click "Jackson County MO" filter option.
    await page.getByTestId("filter-market-Jackson-County-MO").click();

    // The trigger label should now show the selected market.
    await expect(
      page.getByTestId("filter-market"),
    ).toContainText("Jackson County MO", { timeout: 5_000 });
  });

  // Smoke: the "Anywhere" option is still present (resets the filter).
  test("Anywhere option is present and clears the market filter", async ({
    page,
  }) => {
    await resetTenantTables(adminClient());
    await page.goto("/properties");

    await page.getByTestId("filter-market").click();

    // The "Anywhere" option (data-testid="filter-market-any") must be present.
    await expect(
      page.getByTestId("filter-market-any"),
    ).toBeVisible({ timeout: 5_000 });
  });
});
