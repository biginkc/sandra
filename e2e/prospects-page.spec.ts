import { test, expect } from "@playwright/test";

import { adminClient, resetTenantTables, seedProspects } from "./fixtures";

/**
 * Smoke test for /properties. Specifically catches the class of bug we
 * hit during Feature 4: a Base-UI Dropdown*Label context error crashed
 * the page at runtime while all integration tests were green.
 */
test.describe("/properties", () => {
  test("renders without runtime errors, Actions button is always visible", async ({
    page,
  }) => {
    const admin = adminClient();
    await resetTenantTables(admin);
    await seedProspects(admin, 3, "Prospect");

    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/properties");

    // Page must not have crashed into the error boundary.
    await expect(page.locator("text=Something went wrong.")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Prospects", level: 1 }),
    ).toBeVisible();

    // Actions button: always shown, disabled on empty selection.
    const actions = page.getByRole("button", { name: /^Actions/ });
    await expect(actions).toBeVisible();
    await expect(actions).toBeDisabled();
    await expect(actions).toHaveText(/^Actions$/);

    // Import CSV sits next to it.
    await expect(page.getByRole("link", { name: "Import CSV" })).toBeVisible();

    // No runtime errors leaked onto the console.
    expect(errors, errors.join("\n")).toHaveLength(0);
  });

  test("selecting a row enables the Actions menu with count", async ({
    page,
  }) => {
    const admin = adminClient();
    await resetTenantTables(admin);
    await seedProspects(admin, 2, "Pick");

    await page.goto("/properties");
    const rowCheckboxes = page.locator(
      'tbody input[type="checkbox"][aria-label^="Select "]',
    );
    await expect(rowCheckboxes).toHaveCount(2);

    await rowCheckboxes.first().check();

    const actions = page.getByRole("button", { name: /^Actions/ });
    await expect(actions).toBeEnabled();
    await expect(actions).toHaveText(/Actions \(1\)/);
  });
});
