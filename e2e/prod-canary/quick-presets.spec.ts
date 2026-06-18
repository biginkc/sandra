import { expect, test } from "@playwright/test";

import {
  deleteCanaryPropertiesByAddressPrefix,
  deleteCanarySavedFiltersByName,
  insertCanaryProspects,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
  resolveAuthUserId,
  resolvePrimaryMembershipOrgId,
} from "./support";

test("production canary applies and clears the High Equity quick preset", async ({
  page,
}, testInfo) => {
  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const canaryUserId = await resolveAuthUserId(supabase, env.email);
  const canaryOrgId = await resolvePrimaryMembershipOrgId(supabase, canaryUserId);
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const prefix = `${env.label} Quick Preset ${token}`;
  const savedFilterName = `${prefix} Saved Filter`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);
  await deleteCanarySavedFiltersByName(supabase, savedFilterName);

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
    await expect(
      page.getByRole("button", { name: /Save filter/i }),
    ).toHaveCount(0);

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
    await expect(
      page.getByRole("button", { name: /Save filter/i }),
    ).toBeVisible();
    await expect(page.getByText(highEquity.address)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(lowEquity.address)).not.toBeVisible();
    await expect(page.getByText(noEquity.address)).not.toBeVisible();
    await expect(page.getByText(/Showing 1.*of 1 prospect/i)).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __saveFilterNoReloadMarker?: string })
        .__saveFilterNoReloadMarker = "alive";
    });
    await page.getByRole("button", { name: /Save filter/i }).click();
    await page.getByRole("button", { name: /^Save$/i }).click();
    await expect(page.getByText("Please enter a preset name.")).toBeVisible({
      timeout: 10_000,
    });
    const emptySaveLookup = await supabase
      .from("saved_filters")
      .select("id")
      .eq("name", savedFilterName);
    expect(emptySaveLookup.error).toBeNull();
    expect(emptySaveLookup.data).toEqual([]);

    await page.getByLabel("Filter preset name").fill(savedFilterName);
    await page.getByRole("button", { name: /^Save$/i }).click();
    await expect(
      page.getByText(`Saved preset "${savedFilterName}".`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page
        .locator("[data-quick-filters-bar]")
        .locator(`[data-quick-filter-chip][data-preset-name="${savedFilterName}"]`),
    ).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __saveFilterNoReloadMarker?: string })
            .__saveFilterNoReloadMarker ?? null,
        ),
      )
      .toBe("alive");

    const savedFilterLookup = await supabase
      .from("saved_filters")
      .select("id, org_id, user_id, name, starred, is_base")
      .eq("name", savedFilterName)
      .single();
    expect(savedFilterLookup.error).toBeNull();
    expect(savedFilterLookup.data).toEqual(
      expect.objectContaining({
        org_id: canaryOrgId,
        user_id: canaryUserId,
        name: savedFilterName,
        starred: true,
        is_base: false,
      }),
    );

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
    await deleteCanarySavedFiltersByName(supabase, savedFilterName);
    await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);
  }
});
