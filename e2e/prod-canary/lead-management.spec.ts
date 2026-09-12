import { expect, test } from "@playwright/test";

import {
  deleteCanaryPropertiesByAddress,
  insertCanaryProspect,
  pollUntil,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
  resolveAuthUserId,
} from "./support";

test("production canary edits a canary lead detail status, motivation, and assignee", async ({
  page,
}, testInfo) => {
  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const canaryUserId = await resolveAuthUserId(supabase, env.email);
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const address = `${env.label} Manage ${token} 701 Walnut St`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryPropertiesByAddress(supabase, address);

  try {
    const lead = await insertCanaryProspect(supabase, {
      address,
      runId: env.runId,
      fields: {
        status: "new_lead",
        cass_status: "verified",
      },
    });

    await page.goto(`/leads/${lead.id}`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: address })).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole("button", { name: "Change status" }).click();
    await page.getByRole("menuitem", { name: "Interested" }).click();

    await page.getByRole("button", { name: "Change motivation" }).click();
    await page.getByRole("menuitem", { name: "Warm" }).click();

    await page.getByRole("button", { name: "Change assignee" }).click();
    const self = page.getByRole("menuitem", { name: / \(you\)$/ });
    await expect(self).toBeVisible({ timeout: 20_000 });
    const selfLabel = (await self.innerText()).trim();
    await self.click();

    await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("properties")
          .select("id, status, motivation_level, assigned_user_id")
          .eq("id", lead.id)
          .maybeSingle();
        expect(error).toBeNull();
        if (
          data?.status !== "interested" ||
          data.motivation_level !== "warm" ||
          data.assigned_user_id !== canaryUserId
        ) {
          return null;
        }
        return data;
      },
      { label: "canary lead detail edits persisted", timeoutMs: 20_000 },
    );

    await page.reload();
    await expect(
      page.getByRole("button", { name: "Change status" }).filter({
        hasText: "Interested",
      }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("button", { name: "Change motivation" }).filter({
        hasText: "Warm",
      }),
    ).toBeVisible();
    // Team names load when the menu opens. After reload, the trigger initially
    // uses the persisted email fallback; load the roster before comparing names.
    await page.getByRole("button", { name: "Change assignee" }).click();
    await expect(page.getByRole("menuitem", { name: selfLabel, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Change assignee" }),
    ).toHaveText(`Assigned: ${selfLabel}`);
  } finally {
    await deleteCanaryPropertiesByAddress(supabase, address);
  }
});
