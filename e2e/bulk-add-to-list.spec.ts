import { test, expect } from "@playwright/test";

import {
  adminClient,
  resetTenantTables,
  seedList,
  seedProspects,
} from "./fixtures";

/**
 * Bulk action: select three prospects, open the Actions menu, pick a
 * list from the Organize → Add to list submenu. Verifies the action
 * landed in the DB (the UI doesn't render list badges on /properties
 * today, so the strongest assertion is the property_lists row count).
 */
test("bulk add-to-list writes property_lists rows for the selection", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  const prospects = await seedProspects(admin, 3, "Bulk");
  const listId = await seedList(admin, "Probate KC");

  await page.goto("/properties");

  for (const p of prospects) {
    await page
      .locator(
        `tbody input[type="checkbox"][aria-label="Select ${p.address}"]`,
      )
      .check();
  }

  await page
    .getByRole("button", { name: /Actions for 3 selected/ })
    .click();
  await page.getByRole("menuitem", { name: /Add to list/ }).click();
  await page.getByRole("menuitem", { name: "Probate KC" }).click();

  // Confirm memberships landed server-side. Uses retry loop since the
  // server action + router.refresh() race with this SQL read.
  await expect(async () => {
    const { count } = await admin
      .from("property_lists")
      .select("*", { count: "exact", head: true })
      .eq("list_id", listId);
    expect(count).toBe(3);
  }).toPass({ timeout: 5_000 });
});
