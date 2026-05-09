import { test, expect, type Page } from "@playwright/test";

import { adminClient, resetTenantTables } from "./fixtures";

/**
 * Phase 02 smoke spec — /properties Market filter options.
 *
 * PR #145 moved the legacy table filter pills into FilterDrawer blocks. This
 * keeps the original county-market contract, but verifies it through the new
 * drawer UI instead of the removed `data-testid="filter-market"` pill.
 */

function decodedFiltersFromUrl(url: string) {
  const raw = new URL(url).searchParams.get("filters");
  expect(raw).toBeTruthy();
  return JSON.parse(raw as string) as {
    v: number;
    blocks: Array<Record<string, unknown>>;
  };
}

async function addMarketBlock(page: Page) {
  await page.waitForLoadState("networkidle");

  const filtersButton = page.getByRole("button", { name: /^Filters$/i });
  await expect(filtersButton).toBeVisible({ timeout: 10_000 });
  await expect(filtersButton).toBeEnabled();
  await filtersButton.click();

  const drawer = page.locator("[data-slot='sheet-content']");
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await expect(drawer.getByText(/^Filters$/i)).toBeVisible();

  const addBlockButton = drawer.getByRole("button", {
    name: /Add Filter Block/i,
  });
  await expect(addBlockButton).toBeEnabled();
  await addBlockButton.click();

  const picker = page.getByRole("dialog", { name: /Add filter block/i });
  await expect(picker).toBeVisible({ timeout: 10_000 });

  const search = picker.getByPlaceholder(/search filters/i);
  await expect(search).toBeFocused();
  await search.fill("market");
  await picker.getByRole("button", { name: /^Market$/i }).click();

  await expect(
    page.locator("[data-block-row][data-kind='market']"),
  ).toBeVisible({
    timeout: 10_000,
  });
}

async function expectUrlBlocks(
  page: Page,
  assertion: (blocks: Array<Record<string, unknown>>) => void,
) {
  await expect
    .poll(
      () => {
        try {
          assertion(decodedFiltersFromUrl(page.url()).blocks);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

test.describe("Properties — Market filter drawer block (Phase 02 smoke)", () => {
  test("Market block lists county-shaped strings from the seeded counties table", async ({
    page,
  }) => {
    await resetTenantTables(adminClient());
    await page.goto("/properties");

    await addMarketBlock(page);

    await expect(
      page.getByRole("checkbox", { name: "Buchanan County MO" }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("checkbox", { name: "Johnson County KS" }),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: "Jackson County MO" }),
    ).toBeVisible();

    await expect(
      page.getByRole("checkbox", { name: "Kansas City" }),
    ).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "St. Louis" })).toHaveCount(
      0,
    );
  });

  test("selecting a county market filter updates the URL and active chip", async ({
    page,
  }) => {
    await resetTenantTables(adminClient());
    await page.goto("/properties?search=market-drawer");

    await addMarketBlock(page);

    const jackson = page.getByRole("checkbox", { name: "Jackson County MO" });
    await jackson.click();
    await expect(jackson).toBeChecked({ timeout: 250 });

    await expect(page).toHaveURL(/\bfilters=/, { timeout: 10_000 });
    expect(new URL(page.url()).searchParams.get("search")).toBe(
      "market-drawer",
    );
    await expectUrlBlocks(page, (blocks) => {
      expect(blocks).toEqual([
        expect.objectContaining({
          kind: "market",
          combinator: "any",
          values: ["Jackson County MO"],
        }),
      ]);
    });

    await expect(
      page.locator("[data-active-filters-chips] [data-chip-kind='market']"),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("removing the Market block clears only the drawer filter", async ({
    page,
  }) => {
    await resetTenantTables(adminClient());
    await page.goto("/properties?search=market-clear");

    await addMarketBlock(page);

    await page.getByRole("checkbox", { name: "Jackson County MO" }).click();
    await expect(page).toHaveURL(/\bfilters=/, { timeout: 10_000 });
    await expectUrlBlocks(page, (blocks) => {
      expect(blocks).toEqual([
        expect.objectContaining({
          kind: "market",
          values: ["Jackson County MO"],
        }),
      ]);
    });

    await page.getByRole("button", { name: /Remove Market filter/i }).click();
    await expect(page).not.toHaveURL(/\bfilters=/, { timeout: 10_000 });
    expect(new URL(page.url()).searchParams.get("search")).toBe("market-clear");
  });
});
