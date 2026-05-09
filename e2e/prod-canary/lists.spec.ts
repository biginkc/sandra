import { expect, test } from "@playwright/test";

import {
  deleteCanaryListsByName,
  pollUntil,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
} from "./support";

test("production canary creates and archives a canary-owned list", async ({
  page,
}, testInfo) => {
  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const listName = `${env.label} Lists UI`;
  const description = `Created by production Playwright canary ${env.runId}`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryListsByName(supabase, listName);

  try {
    await page.goto("/lists");
    await expect(page).not.toHaveURL(/\/login/);

    await page.getByLabel("Name").fill(listName);
    await page.getByLabel("Description (optional)").fill(description);
    await page.getByRole("button", { name: /^create$/i }).click();

    await expect(page.getByText(listName)).toBeVisible({ timeout: 15_000 });

    const created = await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("lists")
          .select("id, name, description, archived_at")
          .eq("name", listName)
          .maybeSingle();
        if (error) throw error;
        return data;
      },
      { label: "canary list insert" },
    );

    expect(created.description).toBe(description);
    expect(created.archived_at).toBeNull();

    const row = page.getByRole("row").filter({ hasText: listName });
    await row.getByRole("button", { name: /archive list/i }).click();

    await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("lists")
          .select("archived_at")
          .eq("id", created.id)
          .maybeSingle();
        if (error) throw error;
        return data?.archived_at ? data.archived_at : null;
      },
      { label: "canary list archive" },
    );
  } finally {
    await deleteCanaryListsByName(supabase, listName);
  }
});
