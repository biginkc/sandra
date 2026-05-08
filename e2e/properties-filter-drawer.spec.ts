import { test, expect } from "@playwright/test";

test.describe("Phase 05 Plan 09 — full feature flow", () => {
  test("page renders with filters param applied (the prod-bug repro)", async ({ page }) => {
    // This is the bug Jarrad hit: clicking a preset chip navigates to
    // /properties?filters=<json> and the page crashed during server render
    // with `query.order is not a function`. Repro it directly via URL.
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("response", async (r) => {
      if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`);
    });

    const filterState = {
      v: 1,
      blocks: [{ id: "test-vacancy-1", kind: "vacancy", tri: "yes" }],
    };
    const filtersParam = encodeURIComponent(JSON.stringify(filterState));

    await page.goto(`/properties?filters=${filtersParam}`);

    await expect(page.getByText(/Something went wrong/i)).not.toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByRole("button", { name: /^Filters/i })).toBeVisible();

    const activeBar = page.locator("[data-active-filters-chips]");
    await expect(activeBar).toBeVisible({ timeout: 8_000 });
    await expect(activeBar.locator("[data-chip-kind='vacancy']")).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("base preset chip click toggles URL and aria-pressed", async ({ page }) => {
    await page.goto("/properties");
    await page.waitForLoadState("networkidle");
    const bar = page.locator("[data-quick-filters-bar]");
    const vacantChip = bar.locator("[data-quick-filter-chip][data-preset-name='Vacant']");
    await expect(vacantChip).toBeVisible({ timeout: 10_000 });

    await expect(vacantChip).toHaveAttribute("aria-pressed", "false");

    await vacantChip.click();
    await expect(page).toHaveURL(/\bfilters=/, { timeout: 10_000 });
    await expect(vacantChip).toHaveAttribute("aria-pressed", "true");

    const activeBar = page.locator("[data-active-filters-chips]");
    await expect(activeBar).toBeVisible({ timeout: 5_000 });
    await expect(activeBar.locator("[data-chip-kind='vacancy']")).toBeVisible();

    await page.screenshot({ path: "/tmp/plan-09-preset-applied.png", fullPage: true });
  });

  test("opening drawer + adding Vacancy=Yes block updates count CTA", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

    await page.goto("/properties");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /^Filters$/i }).click();
    await expect(page.getByText(/Add a filter to slice your prospects/i)).toBeVisible();

    await page.getByRole("button", { name: /Add Filter Block/i }).click();
    const search = page.getByPlaceholder(/search filters/i);
    await expect(search).toBeFocused();
    await search.fill("vacan");

    await page.getByRole("button", { name: /^Vacancy$/i }).click();

    const yesRadio = page.getByRole("radio", { name: /yes \(vacant\)/i });
    await expect(yesRadio).toBeVisible({ timeout: 5_000 });
    await yesRadio.check();

    const showButton = page.getByRole("button", { name: /Show \d+ prospects/i });
    await expect(showButton).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: "/tmp/plan-09-drawer-vacancy.png", fullPage: true });

    await showButton.click();
    await expect(page).toHaveURL(/\bfilters=/, { timeout: 10_000 });

    expect(errors).toEqual([]);
  });

  test("clicking active preset chip clears the filter", async ({ page }) => {
    await page.goto("/properties");
    await page.waitForLoadState("networkidle");
    const bar = page.locator("[data-quick-filters-bar]");
    const vacantChip = bar.locator("[data-quick-filter-chip][data-preset-name='Vacant']");
    await expect(vacantChip).toBeVisible({ timeout: 10_000 });

    await vacantChip.click();
    await expect(page).toHaveURL(/\bfilters=/, { timeout: 10_000 });
    await expect(vacantChip).toHaveAttribute("aria-pressed", "true");

    await vacantChip.click();
    await expect(page).not.toHaveURL(/\bfilters=/, { timeout: 10_000 });
    await expect(vacantChip).toHaveAttribute("aria-pressed", "false");
  });
});
