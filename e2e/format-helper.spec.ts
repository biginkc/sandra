import { test, expect } from "@playwright/test";

import { adminClient, resetTenantTables } from "./fixtures";

/**
 * Format-helper smoke spec.
 *
 * Verifies the auto-detect + auto-apply flow on the import wizard's
 * upload step, and the help dialog. Uses synthetic in-memory CSVs
 * keyed to each vendor's detection signature — we don't need the
 * file to ingest cleanly, only to trigger the banner.
 *
 * Per project memory `feedback_verify_with_playwright.md`: never ask
 * Jarrad to refresh and check — verify it ourselves.
 */

const BMH_HEADERS =
  "Property Address,First Name,Last Name,Phone,Email,Link,Status,Follow Up,Lead Source,Date Created,County";
const BMH_ROW =
  '"123 Main St, Kansas City, MO 64108",Jane,Smith,816-555-1001,jane@example.com,https://realtor.com/123,Offer Sent,Follow up Needed,realtor.com,February 8 2026,Clay County';

const PROPSTREAM_HEADERS =
  'Address,State,Phone 1,Phone 1 Type,Phone 1 DNC,Phone 2,Phone 2 Type,Phone 2 DNC,Phone 3,Phone 3 Type,Phone 3 DNC,Phone 4,Phone 4 Type,Phone 4 DNC,Phone 5,Phone 5 Type,Phone 5 DNC,Email 1,Owner 1 First Name,Owner 1 Last Name,"Method of Add"';
const PROPSTREAM_ROW =
  '"123 Main St",MO,8165551001,Mobile,,8165551002,Mobile,,8165551003,Landline,,,,,,,,owner@example.com,Jane,Smith,Manual';

const PERMITS_HEADERS = "PermitNum,AppliedDate,IssuedDate,StatusCurrent,Comments";
const PERMITS_ROW = "P-001,2026-01-01,2026-01-15,Issued,Construct new SFR";

async function gotoUploadStep(
  page: import("@playwright/test").Page,
): Promise<void> {
  await resetTenantTables(adminClient());
  await page.goto("/import");
  await page.getByTestId("mode-add").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  // The upload card is now visible.
  await expect(page.getByText("Upload CSV", { exact: true })).toBeVisible();
}

test.describe("Format helper — auto-detect + auto-apply", () => {
  test("BMH outreach: auto-detected + Source set to agent_outreach", async ({ page }) => {
    await gotoUploadStep(page);

    // Upload a synthetic BMH outreach CSV via the hidden file input.
    const csv = `${BMH_HEADERS}\n${BMH_ROW}\n`;
    await page.locator('input[type="file"]#file').setInputFiles({
      name: "bmh-outreach.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv, "utf8"),
    });

    // Banner appears — match by the success copy.
    await expect(
      page.getByText(/Recognized as BMH Agent Outreach Sheets/i),
    ).toBeVisible({ timeout: 10_000 });

    // Source dropdown auto-filled — placeholder is gone (Radix
    // Select hides the placeholder span when a value is set). The
    // banner's "Source set automatically" copy is the secondary signal
    // that the dispatch fired — both must hold.
    await expect(page.locator('text="Pick a source…"')).toHaveCount(0);
    await expect(page.getByText(/Source set automatically/i)).toBeVisible();

    // Undo button restores the pre-transform state.
    await page.getByRole("button", { name: /Undo/ }).click();
    await expect(
      page.getByText(/Recognized as BMH Agent Outreach Sheets/i),
    ).toHaveCount(0);
  });

  test("PropStream: auto-detected + phone-fold note in banner", async ({ page }) => {
    await gotoUploadStep(page);

    const csv = `${PROPSTREAM_HEADERS}\n${PROPSTREAM_ROW}\n`;
    await page.locator('input[type="file"]#file').setInputFiles({
      name: "propstream.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv, "utf8"),
    });

    await expect(
      page.getByText(/Recognized as PropStream Property Export/i),
    ).toBeVisible({ timeout: 10_000 });

    // Phone-fold note should appear in the banner's bullet list.
    await expect(page.getByText(/Folded 5-phone block into 3 slots/i)).toBeVisible();

    // Source auto-filled — see BMH test for selector rationale.
    await expect(page.locator('text="Pick a source…"')).toHaveCount(0);
    await expect(page.getByText(/Source set automatically/i)).toBeVisible();
  });

  test("Permits: detected as non-importable, no transform fires", async ({ page }) => {
    await gotoUploadStep(page);

    const csv = `${PERMITS_HEADERS}\n${PERMITS_ROW}\n`;
    await page.locator('input[type="file"]#file').setInputFiles({
      name: "permits.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv, "utf8"),
    });

    // Info-style banner with the "not a lead source" copy.
    await expect(page.getByText(/Detected: Municipal Permits/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/isn.?t a lead-import source/i)).toBeVisible();

    // No Undo button — transform never fired.
    await expect(page.getByRole("button", { name: /Undo/ })).toHaveCount(0);
  });

  test("Help dialog opens from the upload card link", async ({ page }) => {
    await gotoUploadStep(page);

    await page.getByRole("button", { name: /Need help with your input file/i }).click();

    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Need help with your input file/i }),
    ).toBeVisible();
    // Dialog lists every importable vendor.
    await expect(page.getByText("PropStream Property Export")).toBeVisible();
    await expect(page.getByText("TitlePro / DataTree Title Events")).toBeVisible();
    await expect(page.getByText("REISift / DealMachine Skipped Contacts")).toBeVisible();
    await expect(page.getByText("BMH Agent Outreach Sheets")).toBeVisible();
    // Plus the non-importable section.
    await expect(page.getByText(/Not lead-import sources/i)).toBeVisible();
  });
});
