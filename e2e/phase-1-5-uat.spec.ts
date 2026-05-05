import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

/**
 * Phase 1.5 Visual UAT — runs against prod (https://sandra-sooty.vercel.app).
 *
 * Use with playwright.prod.config.ts:
 *   PROD_EMAIL=you@example.com PROD_PASSWORD=xxx \
 *   npx playwright test e2e/phase-1-5-uat.spec.ts \
 *     --config playwright.prod.config.ts --headed --slow-mo=600
 *
 * Screenshots are saved to docs/design/screenshots/phase-1-5-uat/.
 */

const SCREENSHOT_DIR = path.resolve(
  __dirname,
  "../docs/design/screenshots/phase-1-5-uat",
);

async function screenshot(page: import("@playwright/test").Page, name: string) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, name),
    fullPage: false,
  });
}

// ---------------------------------------------------------------------------
// Auth — runs once before all tests via test.beforeAll
// ---------------------------------------------------------------------------

test.beforeAll(async ({ browser }) => {
  const email = process.env.PROD_EMAIL;
  const password = process.env.PROD_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "Set PROD_EMAIL and PROD_PASSWORD before running this spec.\n" +
        "  PROD_EMAIL=you@example.com PROD_PASSWORD=xxx npx playwright test ...",
    );
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 20_000,
  });

  // Save session so all test workers reuse it
  await context.storageState({ path: "e2e/.auth/prod-uat.json" });
  await context.close();
});

test.use({ storageState: "e2e/.auth/prod-uat.json" });

// ---------------------------------------------------------------------------
// Test 1: /properties — DataTableShell + CircularPagination + SearchInputPill
// ---------------------------------------------------------------------------

test("01 · /properties — card chrome, footer, pagination, pill search", async ({
  page,
}) => {
  await page.goto("/properties");

  // Wait for the DataTableShell container
  const container = page.locator('[data-testid="prospects-table-container"]');
  await expect(container).toBeVisible({ timeout: 15_000 });

  // ── Screenshot 1: full table with card chrome ──
  await screenshot(page, "01-properties-shell.png");

  // Confirm footer shows "Showing X–Y of Z"
  const footer = container.locator("text=/Showing \\d/");
  await expect(footer).toBeVisible();

  // Scroll footer into view and screenshot
  await footer.scrollIntoViewIfNeeded();
  await screenshot(page, "02-properties-footer.png");

  // ── Search: type a term, debounce fires, table narrows ──
  const searchInput = page.locator('input[placeholder*="Search"], input[aria-label*="search" i]').first();
  await searchInput.click();
  await searchInput.fill("Kansas");
  await page.waitForTimeout(400); // debounce
  await screenshot(page, "03-properties-search.png");

  // Clear search
  const clearBtn = page.locator('[aria-label="Clear search"]');
  if (await clearBtn.isVisible()) {
    await clearBtn.click();
    await page.waitForTimeout(300);
  }

  // ── Pagination: click page 2 if available ──
  const page2Btn = page.getByRole("button", { name: "2" });
  if (await page2Btn.isVisible()) {
    await page2Btn.click();
    await page.waitForTimeout(600);
    await screenshot(page, "04-properties-page2.png");
  }
});

// ---------------------------------------------------------------------------
// Test 2: /lists — DataTableShell + count footer
// ---------------------------------------------------------------------------

test("02 · /lists — card chrome and count footer", async ({ page }) => {
  await page.goto("/lists");

  const container = page.locator('[data-testid="lists-table-container"]');
  await expect(container).toBeVisible({ timeout: 15_000 });

  // Footer should show "N list(s)"
  const footer = container.locator("text=/\\d+ list/");
  await expect(footer).toBeVisible();

  await screenshot(page, "05-lists-shell.png");
});

// ---------------------------------------------------------------------------
// Test 3: /jobs — DataTableShell + count footer
// ---------------------------------------------------------------------------

test("03 · /jobs — card chrome and count footer", async ({ page }) => {
  await page.goto("/jobs");

  const container = page.locator('[data-testid="jobs-table-container"]');
  await expect(container).toBeVisible({ timeout: 15_000 });

  // Footer shows "N of M jobs" or "N job(s)"
  const footer = container.locator("text=/\\d+.*job/");
  await expect(footer).toBeVisible();

  await screenshot(page, "06-jobs-shell.png");
});

// ---------------------------------------------------------------------------
// Test 4: /templates — DataTableShell + count footer
// ---------------------------------------------------------------------------

test("04 · /templates — card chrome and count footer", async ({ page }) => {
  await page.goto("/templates");

  // Templates page doesn't have a data-testid on the shell yet — locate by footer text
  const footer = page.locator("text=/\\d+.*template/");
  await expect(footer).toBeVisible({ timeout: 15_000 });

  await screenshot(page, "07-templates-shell.png");
});

// ---------------------------------------------------------------------------
// Test 5: Bulk SMS modal on /properties
// ---------------------------------------------------------------------------

test("05 · /properties — Bulk SMS modal opens with template picker", async ({
  page,
}) => {
  await page.goto("/properties");
  await expect(
    page.locator('[data-testid="prospects-table-container"]'),
  ).toBeVisible({ timeout: 15_000 });

  // Select the first prospect row
  const firstCheckbox = page
    .locator('tbody tr')
    .first()
    .locator('input[type="checkbox"]');
  await firstCheckbox.check();

  // Open the Actions dropdown
  const actionsBtn = page.getByRole("button", { name: /actions/i });
  await actionsBtn.click();

  // Click Bulk SMS
  const bulkSmsOption = page.getByRole("menuitem", { name: /bulk sms/i });
  await expect(bulkSmsOption).toBeVisible();
  await screenshot(page, "08-actions-menu-bulk-sms.png");
  await bulkSmsOption.click();

  // Modal should open
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await screenshot(page, "09-bulk-sms-modal.png");

  // Template pool dropdown should be visible
  const poolDropdown = modal.locator("select, [role='combobox']").first();
  await expect(poolDropdown).toBeVisible();

  // Screenshot with modal fully loaded
  await page.waitForTimeout(300);
  await screenshot(page, "10-bulk-sms-modal-ready.png");

  // Close without sending
  const cancelBtn = modal.getByRole("button", { name: /cancel/i });
  if (await cancelBtn.isVisible()) {
    await cancelBtn.click();
  } else {
    await page.keyboard.press("Escape");
  }
  await expect(modal).not.toBeVisible({ timeout: 3_000 });
});
