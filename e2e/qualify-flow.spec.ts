import { test, expect } from "@playwright/test";

import { adminClient, resetTenantTables, seedProspects } from "./fixtures";

/**
 * Golden path: a prospect selected on /properties qualifies into /leads,
 * then reverting from the lead detail sends it back to /properties.
 */
test.describe("qualify → revert round-trip", () => {
  test("qualify selected moves prospect to /leads kanban", async ({ page }) => {
    const admin = adminClient();
    await resetTenantTables(admin);
    const [prospect] = await seedProspects(admin, 1, "Qualify");

    await page.goto("/properties");
    await page
      .locator(
        `tbody input[type="checkbox"][aria-label="Select ${prospect.address}"]`,
      )
      .check();

    await page
      .getByRole("button", { name: /Actions for 1 selected/ })
      .click();
    await page
      .getByRole("menuitem", { name: "Promote to Lead" })
      .click();

    // Row disappears from /properties.
    await expect(page.locator(`text=${prospect.address}`)).toHaveCount(0);

    // Show up on /leads kanban under New Lead.
    await page.goto("/leads");
    await expect(page.locator(`text=${prospect.address}`)).toBeVisible();
  });

  test("revert-to-prospect from lead detail clears qualified stamps and kicks lead off kanban", async ({
    page,
  }) => {
    const admin = adminClient();
    await resetTenantTables(admin);
    const [prospect] = await seedProspects(admin, 1, "Revert");
    // Pre-qualify so we can exercise the revert path directly, skipping
    // the UI qualify step that's covered by the test above.
    await admin
      .from("properties")
      .update({
        status: "contacted",
        qualified_at: new Date().toISOString(),
        qualified_by: "user-seeded",
      })
      .eq("id", prospect.id);

    await page.goto(`/leads/${prospect.id}`);

    // Confirm dialog ships as a native window.confirm; auto-accept it.
    page.once("dialog", (dialog) => dialog.accept());

    // Open the status widget and pick "Move back to Prospect". The
    // dropdown trigger label reflects the current status.
    await page.getByRole("button", { name: /Change status/i }).click();
    await page
      .getByRole("menuitem", { name: /Move back to Prospect/i })
      .click();

    // Back in the DB, the row should now be a prospect with cleared stamps.
    // Give the server action a beat to settle before reading.
    await expect(async () => {
      const { data } = await admin
        .from("properties")
        .select("status, qualified_at, qualified_by")
        .eq("id", prospect.id)
        .single();
      expect(data?.status).toBe("prospect");
      expect(data?.qualified_at).toBeNull();
      expect(data?.qualified_by).toBeNull();
    }).toPass({ timeout: 5_000 });

    // And it shows up back on /properties.
    await page.goto("/properties");
    await expect(page.locator(`text=${prospect.address}`)).toBeVisible();
  });
});
