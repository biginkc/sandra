import { expect, test } from "@playwright/test";

import {
  deleteCanaryOrganizationsByName,
  deleteCanaryPropertiesByAddressPrefix,
  insertCanaryOrganization,
  insertCanaryProspects,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
  resolveAuthUserId,
  resolvePrimaryMembershipOrgId,
} from "./support";

test("production canary only renders properties from the authenticated user's org", async ({
  page,
}, testInfo) => {
  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const canaryUserId = await resolveAuthUserId(supabase, env.email);
  const canaryOrgId = await resolvePrimaryMembershipOrgId(supabase, canaryUserId);
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const prefix = `${env.label} Membership ${token}`;
  const hiddenOrgName = `${prefix} Hidden Org`;
  const visibleAddress = `${prefix} 801 Visible St`;
  const hiddenAddress = `${prefix} 802 Hidden St`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);
  await deleteCanaryOrganizationsByName(supabase, hiddenOrgName);

  try {
    const hiddenOrg = await insertCanaryOrganization(supabase, {
      name: hiddenOrgName,
    });
    await insertCanaryProspects(supabase, [
      {
        address: visibleAddress,
        runId: env.runId,
        fields: { org_id: canaryOrgId, status: "prospect" },
      },
      {
        address: hiddenAddress,
        runId: env.runId,
        fields: { org_id: hiddenOrg.id, status: "prospect" },
      },
    ]);

    const { data: seededRows, error: seedLookupError } = await supabase
      .from("properties")
      .select("address, org_id")
      .like("address", `${prefix}%`)
      .order("address", { ascending: true });
    expect(seedLookupError).toBeNull();
    expect(seededRows).toEqual([
      expect.objectContaining({ address: visibleAddress, org_id: canaryOrgId }),
      expect.objectContaining({ address: hiddenAddress, org_id: hiddenOrg.id }),
    ]);

    await page.goto("/properties");
    await expect(page).not.toHaveURL(/\/login/);
    await page.getByTestId("prospects-search").fill(token);
    await expect(page.getByText(visibleAddress)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(hiddenAddress)).toHaveCount(0);
    await expect(page.getByText(/Showing 1.*of 1 prospect/i)).toBeVisible();
  } finally {
    await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);
    await deleteCanaryOrganizationsByName(supabase, hiddenOrgName);
  }
});
