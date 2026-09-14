import { expect, test } from "@playwright/test";

import {
  deleteCanaryPropertiesByAddress,
  insertCanaryProspect,
  pollUntil,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
  resolveAuthUserId,
  resolvePrimaryMembershipOrgId,
} from "./support";

test("production My Leads queue finds an owned assignment and persists its note", async ({
  page,
}, testInfo) => {
  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const userId = await resolveAuthUserId(supabase, env.email);
  const orgId = await resolvePrimaryMembershipOrgId(supabase, userId);
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const address = `${env.label} My Leads ${token} 702 Walnut St`;
  const note = `${env.label} My Leads queue note ${token}`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  const { data: membership, error: membershipError } = await supabase
    .from("memberships")
    .select("acquisitions_enabled,access_status")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .single();
  expect(membershipError).toBeNull();
  expect(membership?.access_status).toBe("active");
  expect(membership?.acquisitions_enabled).toBe(true);

  await deleteCanaryPropertiesByAddress(supabase, address);
  try {
    const lead = await insertCanaryProspect(supabase, {
      address,
      runId: env.runId,
      fields: { org_id: orgId, status: "new_lead" },
    });
    // The assignment observer creates the active acquisition episode. Direct
    // writes to its protected table would bypass the production handoff.
    const { error: assignmentError } = await supabase
      .from("properties")
      .update({ assigned_user_id: userId })
      .eq("id", lead.id)
      .eq("org_id", orgId);
    expect(assignmentError).toBeNull();

    await page.goto("/my-leads");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByText("My Leads is not enabled yet.")).toHaveCount(0);
    const search = page.getByRole("textbox", { name: "Search My Leads" });
    await expect(search).toBeVisible({ timeout: 20_000 });
    await search.fill(token);
    const row = page.getByRole("button", { name: `Show details for ${address}` });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();

    const composer = page.getByTestId("lead-add-note-composer");
    await expect(composer).toBeVisible();
    await composer.locator("summary").click();
    await composer.getByRole("textbox", { name: "Add a note" }).fill(note);
    await composer.getByRole("button", { name: "Add", exact: true }).click();

    await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("lead_notes")
          .select("id,body")
          .eq("property_id", lead.id)
          .eq("body", note)
          .maybeSingle();
        expect(error).toBeNull();
        return data;
      },
      { label: "My Leads note persisted", timeoutMs: 20_000 },
    );
    await expect(page.getByText(note, { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("textbox", { name: "Search My Leads" }).fill(token);
    await page.getByRole("button", { name: `Show details for ${address}` }).click();
    await expect(page.getByText(note, { exact: true })).toBeVisible();
  } finally {
    await deleteCanaryPropertiesByAddress(supabase, address);
  }
});
