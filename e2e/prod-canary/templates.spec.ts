import { expect, test } from "@playwright/test";

import {
  deleteCanarySmsTemplatesByName,
  pollUntil,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
} from "./support";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("production canary creates, edits, and deletes a canary SMS template", async ({
  page,
}, testInfo) => {
  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const name = `${env.label} Template ${token}`;
  const editedName = `${name} Edited`;
  const initialContent = `Hi {{first_name | there}}, production canary ${token}.`;
  const editedContent = `Updated canary template ${token} for {{property_address}}.`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanarySmsTemplatesByName(supabase, name);
  await deleteCanarySmsTemplatesByName(supabase, editedName);

  try {
    await page.goto("/templates");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId("templates-table-container")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole("button", { name: "New template" }).click();
    await expect(page.getByRole("dialog", { name: "New template" })).toBeVisible();
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Content").fill(initialContent);
    await page.getByRole("button", { name: "Create template" }).click();

    const created = await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("sms_templates")
          .select("id, name, content, category, deleted_at")
          .eq("name", name)
          .maybeSingle();
        expect(error).toBeNull();
        if (!data || data.deleted_at !== null) return null;
        return data;
      },
      { label: "canary sms template created", timeoutMs: 20_000 },
    );
    expect(created.content).toBe(initialContent);
    expect(created.category).toBe("General");

    await page.reload();
    await page.getByTestId("templates-search").fill(token);
    await expect(page.getByText(name)).toBeVisible({ timeout: 20_000 });

    await page.getByRole("row", { name: new RegExp(escapeRegExp(name)) })
      .getByRole("button", { name: "Edit" })
      .click();
    await expect(page.getByRole("dialog", { name: `Edit: ${name}` })).toBeVisible();
    await page.getByLabel("Name").fill(editedName);
    await page.getByLabel("Content").fill(editedContent);
    await page.getByRole("button", { name: "Save changes" }).click();

    await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("sms_templates")
          .select("id, name, content, deleted_at")
          .eq("id", created.id)
          .maybeSingle();
        expect(error).toBeNull();
        if (
          data?.name !== editedName ||
          data.content !== editedContent ||
          data.deleted_at !== null
        ) {
          return null;
        }
        return data;
      },
      { label: "canary sms template edited", timeoutMs: 20_000 },
    );

    await page.reload();
    await page.getByTestId("templates-search").fill(token);
    await expect(page.getByText(editedName)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(editedContent.slice(0, 40))).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("row", { name: new RegExp(escapeRegExp(editedName)) })
      .getByRole("button", { name: "Delete" })
      .click();

    await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("sms_templates")
          .select("id, deleted_at")
          .eq("id", created.id)
          .maybeSingle();
        expect(error).toBeNull();
        if (!data?.deleted_at) return null;
        return data;
      },
      { label: "canary sms template soft deleted", timeoutMs: 20_000 },
    );

    await page.reload();
    await page.getByTestId("templates-search").fill(token);
    await expect(page.getByText(editedName)).not.toBeVisible({ timeout: 20_000 });
  } finally {
    await deleteCanarySmsTemplatesByName(supabase, name);
    await deleteCanarySmsTemplatesByName(supabase, editedName);
  }
});
