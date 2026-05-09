import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/supabase/types";
import {
  deleteCanaryOrganizationsByName,
  deleteCanaryPropertiesByAddressPrefix,
  insertCanaryOrganization,
  insertCanaryProspects,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
} from "./support";

async function resolveAuthUserId(
  client: SupabaseClient<Database>,
  email: string,
): Promise<string> {
  const { data, error } = await client.auth.admin.listUsers();
  if (error) {
    throw new Error(`Could not list production canary auth users: ${error.message}`);
  }

  const user = data.users.find(
    (candidate) => candidate.email?.toLowerCase() === email.toLowerCase(),
  );
  if (!user) {
    throw new Error(`Could not resolve production canary user id for ${email}.`);
  }
  return user.id;
}

async function resolvePrimaryMembershipOrgId(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<string> {
  const { data, error } = await client
    .from("memberships")
    .select("org_id, role")
    .eq("user_id", userId)
    .limit(2);
  if (error) {
    throw new Error(`Could not resolve production canary membership: ${error.message}`);
  }
  if (!data || data.length !== 1) {
    throw new Error(
      `Expected exactly one production canary membership, found ${data?.length ?? 0}.`,
    );
  }
  return data[0].org_id;
}

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
    await expect(page.getByText(/Showing 1.*of 1 prospects/i)).toBeVisible();
  } finally {
    await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);
    await deleteCanaryOrganizationsByName(supabase, hiddenOrgName);
  }
});
