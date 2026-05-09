import { expect, test } from "@playwright/test";

import {
  deleteCanaryPropertiesByAddressPrefix,
  insertCanaryProspects,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
} from "./support";

test("production canary applies and clears the High Equity quick preset", async ({
  page,
}, testInfo) => {
  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const prefix = `${env.label} Quick Preset ${token}`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);

  try {
    const [highEquity, lowEquity, noEquity] = await insertCanaryProspects(
      supabase,
      [
        {
          address: `${prefix} High Equity 301 Pine St`,
          runId: env.runId,
          fields: {
            arv: 200_000,
            equity_estimate: 150_000,
            cass_status: "verified",
          },
        },
        {
          address: `${prefix} Low Equity 302 Pine St`,
          runId: env.runId,
          fields: {
            arv: 200_000,
            equity_estimate: 40_000,
            cass_status: "verified",
          },
        },
        {
          address: `${prefix} Missing Equity 303 Pine St`,
          runId: env.runId,
          fields: {
            arv: null,
            equity_estimate: null,
            cass_status: "verified",
          },
        },
      ],
    );

    await page.goto("/properties");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId("prospects-table-container")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("prospects-search").fill(token);
    await expect(page).toHaveURL(new RegExp(`search=${encodeURIComponent(token)}`), {
      timeout: 10_000,
    });
    await expect(page.getByText(highEquity.address)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(lowEquity.address)).toBeVisible();
    await expect(page.getByText(noEquity.address)).toBeVisible();
    await expect(page.getByText(/Showing 1.*of 3 prospects/i)).toBeVisible();

    const highEquityChip = page
      .locator("[data-quick-filters-bar]")
      .locator("[data-quick-filter-chip][data-preset-name='High Equity']");
    await expect(highEquityChip).toBeVisible({ timeout: 10_000 });
    await expect(highEquityChip).toHaveAttribute("aria-pressed", "false");

    await highEquityChip.click();
    await expect(highEquityChip).toHaveAttribute("aria-pressed", "true", {
      timeout: 10_000,
    });
    await expect(page).toHaveURL(/\bfilters=/, { timeout: 10_000 });
    await expect(page.getByText(highEquity.address)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(lowEquity.address)).not.toBeVisible();
    await expect(page.getByText(noEquity.address)).not.toBeVisible();
    await expect(page.getByText(/Showing 1.*of 1 prospect/i)).toBeVisible();

    await highEquityChip.click();
    await expect(highEquityChip).toHaveAttribute("aria-pressed", "false", {
      timeout: 10_000,
    });
    await expect(page).not.toHaveURL(/\bfilters=/, { timeout: 10_000 });
    await expect(page.getByText(highEquity.address)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(lowEquity.address)).toBeVisible();
    await expect(page.getByText(noEquity.address)).toBeVisible();
    await expect(page.getByText(/Showing 1.*of 3 prospects/i)).toBeVisible();
  } finally {
    await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);
  }
});
