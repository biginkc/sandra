/**
 * Smoke-test the CSV import end-to-end via Playwright.
 *
 * Walks the wizard: Mode (add) → Upload (file + source + market) →
 * Map (autodetect) → Review → Confirm → Start Import. Then watches
 * /jobs until the import row reaches a terminal status. Reports
 * progress + final status to stdout. Screenshots each step into /tmp
 * for debugging.
 *
 * Usage:
 *   npx tsx scripts/verify-import-smoke.ts <path-to-csv>
 *
 * Defaults to import-test-01-tiny-5.csv if no path is given.
 */

import { chromium, type Page } from "@playwright/test";
import path from "node:path";

const PROD_URL = "https://sandra-sooty.vercel.app";
const DEFAULT_FILE = path.join(
  process.env.HOME ?? "",
  "Downloads",
  "import-test-01-tiny-5.csv",
);

async function main() {
  const filePath = process.argv[2] ?? DEFAULT_FILE;
  const email = process.env.VERIFY_EMAIL ?? "claude@test.com";
  const password = process.env.VERIFY_PASSWORD ?? "test12345";

  console.log(`→ Smoke-testing /import on ${PROD_URL}`);
  console.log(`  file: ${filePath}`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[browser console error] ${msg.text()}`);
  });
  page.on("pageerror", (err) => console.log(`[browser page error] ${err.message}`));

  // ---- 1. Sign in ----------------------------------------------------------
  console.log(`\n[1/7] Sign in as ${email}`);
  await page.goto(`${PROD_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  console.log(`  ✓ on ${page.url()}`);

  // ---- 2. Navigate to /import ----------------------------------------------
  console.log(`\n[2/7] Navigate to /import`);
  await page.goto(`${PROD_URL}/import`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await screenshot(page, "step-1-import-landing");

  // ---- 3. Mode: pick "Add new properties" ----------------------------------
  console.log(`\n[3/7] Mode → "Add new properties"`);
  // The Mode step renders two tiles. Click the one for the Add (insert) flow.
  // The label varies per design; try a few selectors and pick whichever hits.
  const addModeTile = page
    .getByRole("button", { name: /add new|insert|new properties/i })
    .first();
  await addModeTile.waitFor({ state: "visible", timeout: 10000 });
  await addModeTile.click();
  await page.getByRole("button", { name: /^next$/i }).click();
  await screenshot(page, "step-2-after-mode");

  // ---- 4. Upload step: file + source + market ------------------------------
  console.log(`\n[4/7] Upload step (file + source + market)`);
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: "attached", timeout: 10000 });
  await fileInput.setInputFiles(filePath);
  console.log(`  ✓ uploaded file: ${path.basename(filePath)}`);
  // Wait for papaparse to finish + the wizard state to populate
  // ("X rows · Y columns" line confirms FILE_PARSED dispatched).
  await page.waitForSelector("text=/\\d+ rows · \\d+ columns/", {
    timeout: 15000,
  });
  console.log(`  ✓ file parsed`);

  // Source: Radix Select trigger has aria-haspopup="listbox" and the
  // placeholder text "Pick a source…" until something is picked.
  console.log(`  → picking source: Generic`);
  await page.getByText("Pick a source…").click();
  await page.getByRole("option", { name: "Generic" }).click();

  console.log(`  → picking market: Kansas City`);
  await page.getByText("Pick a market…").click();
  await page.getByRole("option", { name: "Kansas City" }).click();

  await screenshot(page, "step-3-upload-filled");
  // The Next button is enabled once file+source+market+rows are all set.
  // Wait briefly for re-render before clicking.
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /^next$/i }).click();

  // ---- 5. Map step: autodetect-only, just go forward -----------------------
  console.log(`\n[5/7] Map step → autodetect, advance`);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await screenshot(page, "step-4-map");
  await page.getByRole("button", { name: /^next$/i }).click();

  // ---- 6. Review → Confirm → Start Import ----------------------------------
  console.log(`\n[6/7] Review → Confirm → Start Import`);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await screenshot(page, "step-5-review");
  await page.getByRole("button", { name: /^next$/i }).click();

  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await screenshot(page, "step-6-confirm");

  // The Start Import button uses the same primary button; its label is
  // "Start import" on the Confirm step.
  await page
    .getByRole("button", { name: /start import|starting/i })
    .click({ timeout: 5000 });

  // ---- 7. Watch /jobs for terminal status ----------------------------------
  console.log(`\n[7/7] Watching /jobs for terminal status (up to 5 min)`);
  // Wait briefly for the action to return + GOTO progress, then jump to /jobs
  // for a more reliable progress view.
  await page.waitForTimeout(2000);
  await page.goto(`${PROD_URL}/jobs`, { waitUntil: "domcontentloaded" });

  const deadline = Date.now() + 5 * 60_000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const text = await page.locator("body").innerText().catch(() => "");
    // Look for a terminal status line for our most recent import row.
    // The /jobs UI renders status badges with text like "completed",
    // "partial", "failed", "running", "queued". The most recent import
    // is at the top of the list.
    const m = text.match(
      /(completed|partial|failed|running|queued)\s+.*?Import import-test/i,
    );
    const status = m?.[1] ?? "(no row found yet)";
    if (status !== lastStatus) {
      console.log(`  ${new Date().toISOString().slice(11, 19)}  status=${status}`);
      lastStatus = status;
    }
    if (status === "completed" || status === "partial" || status === "failed") {
      await screenshot(page, `step-7-jobs-${status}`);
      console.log(`\n✓ Final status: ${status}`);
      await browser.close();
      process.exit(status === "failed" ? 1 : 0);
    }
    await page.waitForTimeout(5000);
    await page.reload({ waitUntil: "domcontentloaded" });
  }

  console.log(`\n✗ Timed out after 5 min — last status: ${lastStatus}`);
  await screenshot(page, "step-7-jobs-timeout");
  await browser.close();
  process.exit(1);
}

async function screenshot(page: Page, name: string): Promise<void> {
  const out = `/tmp/import-smoke-${name}.png`;
  await page.screenshot({ path: out, fullPage: true });
  console.log(`  screenshot → ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
