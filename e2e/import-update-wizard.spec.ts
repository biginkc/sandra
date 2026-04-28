import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { normalizeAddress } from "../src/lib/csv/normalize";
import { adminClient, resetTenantTables } from "./fixtures";

/**
 * Import Wizard — Update Mode (V1) E2E.
 *
 * Covers cases 31-37 from the plan:
 *   31. /import → click Update Data → sub-op checkboxes render
 *   32. Pick "Update property status" → "See example" → modal renders
 *   33. Upload CSV with 3 known + 1 unknown → preview buckets correct
 *   34. Click "Export matched" → file downloads with the 3 matched rows
 *   35. Tag sub-op: 1 known + 2 unknown tags → "Copy unknown tags" → clipboard
 *   36. Click "Confirm & apply" → background job runs → DB statuses updated
 *   37. Switch to Add Data → existing flow renders unchanged (regression guard)
 */

async function seedProperty(admin: ReturnType<typeof adminClient>, address: string, status = "new_lead") {
  const { data, error } = await admin
    .from("properties")
    .insert({
      address,
      address_normalized: normalizeAddress(address),
      state: "MO",
      status,
      market: "Kansas City",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedProperty failed");
  return data.id;
}

async function seedTag(admin: ReturnType<typeof adminClient>, name: string) {
  const { data, error } = await admin
    .from("tags")
    .insert({ name, category: "custom" })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedTag failed");
  return data.id;
}

async function writeTempCsv(name: string, contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sandra-e2e-"));
  const filepath = path.join(dir, name);
  await fs.writeFile(filepath, contents, "utf8");
  return filepath;
}

async function uploadFile(page: Page, filepath: string) {
  // The hidden input has id="update-file" — set the file directly so we
  // don't depend on drag-and-drop in headless Chromium.
  await page.locator("input#update-file").setInputFiles(filepath);
}

test("31. /import → Update Data → sub-op list renders all 7 options", async ({
  page,
}) => {
  await resetTenantTables(adminClient());
  await page.goto("/import");
  await page.getByTestId("mode-update").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  for (const id of [
    "update-property-status",
    "tag-existing-properties",
    "update-motivation-level",
    "update-homeowner-phones",
    "update-agent-phones",
    "update-homeowner-emails",
    "update-agent-emails",
  ]) {
    await expect(page.getByTestId(`subop-${id}`)).toBeVisible();
  }
});

test("32. See example → modal opens with sample headers + rows", async ({
  page,
}) => {
  await resetTenantTables(adminClient());
  await page.goto("/import");
  await page.getByTestId("mode-update").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByTestId("subop-update-property-status-example").click();

  await expect(
    page.getByRole("heading", { name: /update property status — example/i }),
  ).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Address" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "123 Main St" })).toBeVisible();
});

test("33+34. Upload 3 known + 1 unknown → preview buckets + export matched", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await seedProperty(admin, "100 E2E St");
  await seedProperty(admin, "101 E2E St");
  await seedProperty(admin, "102 E2E St");

  const csv = [
    "Address,Status",
    "100 E2E St,contacted",
    "101 E2E St,interested",
    "102 E2E St,offer_sent",
    "999 Missing St,contacted",
  ].join("\n");
  const filepath = await writeTempCsv("status-update.csv", csv);

  await page.goto("/import");
  await page.getByTestId("mode-update").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByTestId("subop-update-property-status").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await uploadFile(page, filepath);
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await expect(
    page.getByText(/will update — 3 rows/i),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/couldn.t match — 1 rows/i),
  ).toBeVisible();

  // 34. Export matched → triggers a download.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-matched").click(),
  ]);
  expect(download.suggestedFilename()).toBe("matched.csv");
});

test("35. Tag sub-op with 1 existing + 2 unknown tags → Copy unknown tags surfaces clipboard", async ({
  page,
  context,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await seedProperty(admin, "200 Tag E2E St");
  await seedProperty(admin, "201 Tag E2E St");
  await seedProperty(admin, "202 Tag E2E St");
  await seedTag(admin, "hot");

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const csv = [
    "Address,Tags",
    "200 Tag E2E St,hot",
    "201 Tag E2E St,schmurf",
    "202 Tag E2E St,florp",
  ].join("\n");
  const filepath = await writeTempCsv("tags-update.csv", csv);

  await page.goto("/import");
  await page.getByTestId("mode-update").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByTestId("subop-tag-existing-properties").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await uploadFile(page, filepath);
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await expect(
    page.getByText(/will update — 1 rows/i),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/couldn.t match — 2 rows/i),
  ).toBeVisible();

  await page.getByTestId("copy-unknown-tags").click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  // Order is sorted alphabetically by the runner.
  expect(clipboard).toBe("florp, schmurf");
});

test("36. Confirm & apply → background job runs → DB statuses updated", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  const id1 = await seedProperty(admin, "300 Apply E2E St", "new_lead");
  const id2 = await seedProperty(admin, "301 Apply E2E St", "new_lead");
  const id3 = await seedProperty(admin, "302 Apply E2E St", "new_lead");

  const csv = [
    "Address,Status",
    "300 Apply E2E St,contacted",
    "301 Apply E2E St,interested",
    "302 Apply E2E St,offer_sent",
  ].join("\n");
  const filepath = await writeTempCsv("apply.csv", csv);

  await page.goto("/import");
  await page.getByTestId("mode-update").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByTestId("subop-update-property-status").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await uploadFile(page, filepath);
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await expect(
    page.getByText(/will update — 3 rows/i),
  ).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /confirm & apply/i }).click();

  await expect(async () => {
    const { data: rows } = await admin
      .from("properties")
      .select("id, status")
      .in("id", [id1, id2, id3]);
    const byId = new Map((rows ?? []).map((r) => [r.id, r.status]));
    expect(byId.get(id1)).toBe("contacted");
    expect(byId.get(id2)).toBe("interested");
    expect(byId.get(id3)).toBe("offer_sent");
  }).toPass({ timeout: 15_000 });
});

test("37. Switch to Add Data → existing flow renders unchanged (regression guard)", async ({
  page,
}) => {
  await resetTenantTables(adminClient());
  await page.goto("/import");
  await page.getByTestId("mode-add").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  // The Add path's first step is the original Upload card with Source +
  // Market selects — confirms the existing wizard still wires up.
  await expect(page.getByText(/upload csv/i).first()).toBeVisible();
  await expect(page.getByText(/Source/i).first()).toBeVisible();
  await expect(page.getByText(/Market/i).first()).toBeVisible();
});
