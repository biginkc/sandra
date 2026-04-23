import { expect, test } from "@playwright/test";

import { seedStarterLibrary } from "../src/lib/sequences/starter-library";

import { adminClient, ensureTestUser, resetTenantTables } from "./fixtures";

/**
 * Feature 5a — Sequences V1 smoke. Exercises the full stack:
 *   1. /sequences index renders the migration-seeded starter library
 *      (4 sequences, since the 5th deferred with assign_task).
 *   2. New-sequence form creates a sequence + redirects to its editor.
 *
 * Deeper flows (enroll-from-lead-detail, edit-template + impact modal,
 * drip chip on kanban card) are covered via the integration suite
 * against a real DB; these E2E tests are the browser-layer safety net.
 */

test("/sequences index renders the starter library after org-level re-seed", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  // Re-seed the starter library for the org (reset truncated sequences).
  const { data: org } = await admin
    .from("organizations")
    .select("id")
    .limit(1)
    .single();
  await seedStarterLibrary(admin, org!.id);

  await page.goto("/sequences");
  await expect(page.getByRole("heading", { name: "Sequences" })).toBeVisible();
  await expect(page.getByText("First touch new lead")).toBeVisible();
  await expect(page.getByText("Nurture cold lead")).toBeVisible();
  await expect(page.getByText("Nurture not-interested")).toBeVisible();
  await expect(page.getByText("Dead lead requalify")).toBeVisible();
});

test("new-sequence form creates a sequence and redirects to its editor", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  await page.goto("/sequences/new");
  await expect(page.getByRole("heading", { name: "New sequence" })).toBeVisible();

  const uniqueName = `E2E smoke ${Date.now()}`;
  await page.getByLabel("Name").fill(uniqueName);
  await page.getByLabel("Description").fill("created by playwright");
  await page.getByRole("button", { name: /^create$/i }).click();

  // Editor URL is /sequences/<uuid>/edit; wait for the sequence title.
  await page.waitForURL(/\/sequences\/[0-9a-f-]+\/edit$/, { timeout: 10_000 });
  await expect(page.getByRole("heading", { name: uniqueName })).toBeVisible();

  // DB side-effect: sequence row exists.
  const { data } = await admin
    .from("sequences")
    .select("name, description, append_opt_out")
    .eq("name", uniqueName)
    .single();
  expect(data).toMatchObject({
    name: uniqueName,
    description: "created by playwright",
    append_opt_out: true,
  });
});
