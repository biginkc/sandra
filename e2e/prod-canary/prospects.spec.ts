import { expect, test } from "@playwright/test";

import {
  deleteCanaryPropertiesByAddress,
  insertCanaryProspect,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
} from "./support";

test("production canary finds a canary-owned prospect through UI search", async ({
  page,
}, testInfo) => {
  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const address = `${env.label} 101 Search ${token} Ave`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryPropertiesByAddress(supabase, address);

  try {
    const property = await insertCanaryProspect(supabase, {
      address,
      runId: env.runId,
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

    const { data, error } = await supabase
      .from("properties")
      .select("id, address, status")
      .eq("id", property.id)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data?.address).toBe(address);
    expect(data?.status).toBe("prospect");
  } finally {
    await deleteCanaryPropertiesByAddress(supabase, address);
  }
});
