import { expect, test } from "@playwright/test";

import {
  deleteCanaryPropertiesByAddress,
  insertCanaryProspect,
  pollUntil,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
} from "./support";

test("production canary promotes a canary prospect into the leads pipeline", async ({
  page,
}, testInfo) => {
  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const address = `${env.label} Qualify ${token} 501 Cedar St`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryPropertiesByAddress(supabase, address);

  try {
    const prospect = await insertCanaryProspect(supabase, {
      address,
      runId: env.runId,
      fields: {
        cass_status: "verified",
        is_vacant: false,
      },
    });

    await page.goto("/properties");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId("prospects-table-container")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("prospects-search").fill(token);
    await expect(page).toHaveURL(new RegExp(`search=${encodeURIComponent(token)}`), {
      timeout: 10_000,
    });
    await expect(page.getByText(address)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Showing 1.*of 1 prospect/i)).toBeVisible();

    await page
      .locator(`tbody input[type="checkbox"][aria-label="Select ${address}"]`)
      .check();
    await page
      .getByRole("button", { name: /Actions for 1 selected/ })
      .click();
    await page.getByRole("menuitem", { name: "Promote to Lead" }).click();

    const promoted = await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("properties")
          .select("id, address, status, qualified_at, qualified_by")
          .eq("id", prospect.id)
          .maybeSingle();
        expect(error).toBeNull();
        if (data?.status !== "new_lead" || !data.qualified_at) return null;
        return data;
      },
      { label: "canary prospect promoted to lead", timeoutMs: 20_000 },
    );
    expect(promoted.address).toBe(address);
    expect(promoted.qualified_by).toBeTruthy();

    await expect(page.getByText(address)).not.toBeVisible({ timeout: 20_000 });

    await page.goto("/leads");
    await expect(page.getByText(address)).toBeVisible({ timeout: 20_000 });

    await page.goto(`/leads/${prospect.id}`);
    await expect(page.getByRole("heading", { name: address })).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await deleteCanaryPropertiesByAddress(supabase, address);
  }
});
