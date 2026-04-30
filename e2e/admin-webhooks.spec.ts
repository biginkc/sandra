import { expect, test } from "@playwright/test";

import { adminClient } from "./fixtures";

/**
 * /admin/webhooks E2E.
 *
 * Covers the headline UX promises:
 *   1. Admin can add a lead consumer end-to-end via the dialog.
 *   2. The plaintext secret is shown exactly once, in the success state.
 *   3. After a refresh, the plaintext is gone — only metadata remains.
 *   4. Rotating the row produces a new plaintext that differs from the
 *      first.
 *
 * The test user (claude@test.com) is an admin in the e2e env because
 * `playwright.config.ts` sets `ADMIN_EMAILS=claude@test.com,...`.
 *
 * Cleanup: webhook_consumers isn't part of `reset_tenant_tables` (it's
 * an admin-config table, not tenant data), so we wipe per-test by name
 * prefix to avoid collisions across runs.
 */

const TEST_NAME_PREFIX = "E2E Admin Webhooks";

async function clearTestConsumers(): Promise<void> {
  const admin = adminClient();
  await admin
    .from("webhook_consumers")
    .delete()
    .ilike("name", `${TEST_NAME_PREFIX}%`);
}

test.describe("/admin/webhooks", () => {
  test.beforeEach(async () => {
    await clearTestConsumers();
  });
  test.afterEach(async () => {
    await clearTestConsumers();
  });

  test("create a lead consumer, see plaintext once, refresh hides it, rotate yields a new plaintext", async ({
    page,
  }) => {
    const consumerName = `${TEST_NAME_PREFIX} ${Date.now()}`;

    await page.goto("/admin/webhooks");
    await expect(
      page.getByRole("heading", { name: "Webhooks", level: 1 }),
    ).toBeVisible();

    // ----- Create flow -----
    await page
      .getByRole("button", { name: /Add webhook consumer/i })
      .first()
      .click();
    await page.getByTestId("webhook-name").fill(consumerName);
    // type=lead is the default radio; select default_source = cold_call.
    await page.getByTestId("webhook-source").click();
    await page.getByRole("option", { name: "cold_call" }).click();
    await page.getByTestId("webhook-submit").click();

    // Success state shows the plaintext + URL.
    const successPanel = page.getByTestId("webhook-success");
    await expect(successPanel).toBeVisible();
    const secretCode = page.getByTestId("webhook-secret-value");
    await expect(secretCode).toBeVisible();
    const firstSecret = (await secretCode.textContent())?.trim() ?? "";
    expect(firstSecret).toMatch(/^[0-9a-f]{48}$/);

    const urlCode = page.getByTestId("webhook-url-value");
    await expect(urlCode).toContainText("/api/webhooks/leads/");
    await expect(urlCode).toContainText(firstSecret);

    // Close the success state — also triggers a refresh so the row
    // appears in the table.
    await page.getByTestId("webhook-success-close").click();

    // The row is in the table.
    const row = page.getByRole("row").filter({ hasText: consumerName });
    await expect(row).toBeVisible();
    await expect(row.getByText("lead", { exact: true })).toBeVisible();
    await expect(row.getByText("cold_call")).toBeVisible();

    // ----- Refresh-hides-plaintext check -----
    await page.reload();
    await expect(
      page.getByRole("row").filter({ hasText: consumerName }),
    ).toBeVisible();
    // The plaintext must not be present anywhere on the page after a
    // refresh — the only place it lives is the in-memory success state.
    await expect(page.locator("body")).not.toContainText(firstSecret);

    // ----- Rotate flow -----
    const rotateRow = page.getByRole("row").filter({ hasText: consumerName });
    await rotateRow
      .getByRole("button", { name: new RegExp(`Rotate secret for ${consumerName}`, "i") })
      .click();
    await page.getByTestId("rotate-confirm").click();

    const rotatedSecretCode = page.getByTestId("webhook-secret-value");
    await expect(rotatedSecretCode).toBeVisible();
    const secondSecret = (await rotatedSecretCode.textContent())?.trim() ?? "";
    expect(secondSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(secondSecret).not.toBe(firstSecret);

    await page.getByTestId("webhook-success-close").click();
  });
});
