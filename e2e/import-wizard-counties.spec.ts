import { test, expect } from "@playwright/test";

import { adminClient, resetTenantTables } from "./fixtures";

/**
 * Phase 02 smoke spec — Import Wizard county dropdown.
 *
 * Verifies that the Market select on the Add Data upload step renders
 * county-shaped strings fetched from the seeded counties table (migration 044),
 * NOT the old hardcoded city-shaped KNOWN_MARKETS array that was deleted in
 * plan 02-03.
 *
 * Per project memory `feedback_verify_with_playwright.md`:
 *   never ask Jarrad to refresh and check — verify it ourselves.
 *
 * Auth: the `chromium` project loads storageState from e2e/.auth/user.json
 * (set up by auth.setup.ts), so no manual login is needed here.
 *
 * Test DB precondition: migration 044 has seeded at least the 18 confirmed
 * BMH counties (including Buchanan County MO, Johnson County KS, Lincoln
 * Parish LA) with the county-shaped market strings. Migration 047 populated
 * counties.fips_code.
 */

test.describe("Import wizard — county dropdown (Phase 02 smoke)", () => {
  test("market dropdown lists county-shaped strings from the seeded counties table", async ({
    page,
  }) => {
    await resetTenantTables(adminClient());
    await page.goto("/import");

    // Navigate to the Add Data mode.
    await page.getByTestId("mode-add").click();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // The Upload step is now visible — Market select is on this step.
    // The Radix Select trigger is the button labelled by the <Label>Market</Label>.
    const marketTrigger = page.getByRole("combobox").filter({ hasText: /pick a market/i }).or(
      page.locator('[aria-label*="arket"]'),
    );

    // Radix SelectTrigger renders as role="combobox"; filter by placeholder text.
    const selectTrigger = page.getByRole("combobox").filter({ hasText: /pick a market/i });
    await selectTrigger.click();

    // After clicking, Radix renders a listbox / option elements.
    // Assert at least 3 seeded county-shaped market strings are present.
    // Using getByRole("option") which Radix Select renders for each SelectItem.
    await expect(
      page.getByRole("option", { name: "Buchanan County MO" }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("option", { name: "Johnson County KS" }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: "Lincoln Parish LA" }),
    ).toBeVisible();

    // Negative assertions: legacy city-shaped strings must NOT appear.
    // These were the old KNOWN_MARKETS values (deleted in plan 02-03).
    await expect(
      page.getByRole("option", { name: "St. Louis" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("option", { name: "Dayton" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("option", { name: "Lake of the Ozarks" }),
    ).toHaveCount(0);
  });

  // Smoke: selecting a county option sets the market value in the trigger.
  test("selecting a county option updates the market trigger label", async ({
    page,
  }) => {
    await resetTenantTables(adminClient());
    await page.goto("/import");

    await page.getByTestId("mode-add").click();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Open the market dropdown (Radix SelectTrigger = role="combobox").
    await page.getByRole("combobox").filter({ hasText: /pick a market/i }).click();

    // Select Jackson County MO.
    await page.getByRole("option", { name: "Jackson County MO" }).click();

    // After selection the trigger shows the county market string.
    await expect(
      page.getByRole("combobox").filter({ hasText: "Jackson County MO" }),
    ).toBeVisible({ timeout: 5_000 });
  });
});
