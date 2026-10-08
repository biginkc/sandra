import { expect, test } from "@playwright/test";

/**
 * /messages-v2 smoke. The shared E2E project cannot be assumed to have the
 * pipeline_runs migration or seeded runs, so this asserts the page chrome and
 * both columns only (empty states are fine; rows may also be present).
 * The shared test user is an org owner, which passes the Messages v2 gate.
 */
test.describe("/messages-v2", () => {
  test("renders the header and both columns", async ({ page }) => {
    await page.goto("/messages-v2");

    await expect(page.getByRole("heading", { name: "Messages v2" })).toBeVisible();
    await expect(page.getByTestId("header-status")).toContainText("runs last hour");
    await expect(page.getByLabel("Live feed", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Holds", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Shadow scorecard", { exact: true })).toContainText(/2h of shadow traffic/i);
    await expect(page.getByLabel("Legend", { exact: true })).toBeVisible();
  });
});
