import { expect, test, type Page } from "@playwright/test";

import {
  deleteCanaryImportArtifactsByFilename,
  deleteCanaryPropertiesByAddressPrefix,
  pollUntil,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
} from "./support";

async function selectComboboxOption(
  page: Page,
  triggerText: RegExp,
  optionName: string,
) {
  await page.getByRole("combobox").filter({ hasText: triggerText }).click();
  await page.getByRole("option", { name: optionName }).click();
}

test("production canary imports a canary CSV and renders the created prospects", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);

  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const prefix = `${env.label} Import ${token}`;
  const filename = `${env.label} import ${token}.csv`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  const csv = [
    "Address,City,State,Zip,ARV,Equity Estimate",
    `"${prefix} 401 Maple St",Kansas City,MO,64151,200000,125000`,
    `"${prefix} 402 Maple St",Kansas City,MO,64151,150000,90000`,
  ].join("\n");

  await deleteCanaryImportArtifactsByFilename(supabase, filename);
  await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);

  try {
    await page.goto("/import");
    await expect(page).not.toHaveURL(/\/login/);
    await page.getByTestId("mode-add").click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("Upload CSV", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await page.locator('input[type="file"]#file').setInputFiles({
      name: filename,
      mimeType: "text/csv",
      buffer: Buffer.from(csv, "utf8"),
    });
    await expect(page.getByRole("main").getByText(filename)).toBeVisible({
      timeout: 10_000,
    });

    await selectComboboxOption(page, /pick a source/i, "Direct mail");
    await selectComboboxOption(page, /pick a market/i, "Jackson County MO");

    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText(/Detected columns/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/2\/2 required/i)).toBeVisible();

    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText(/Will import/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/2 of 2/i)).toBeVisible();
    await expect(page.getByText(/Blocked/i)).toBeVisible();

    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText(/Ready to import/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/2 valid of 2 total/i)).toBeVisible();

    await page.getByRole("button", { name: /Start import/i }).click();
    await expect(page.getByText(/Importing|Import complete/i)).toBeVisible({
      timeout: 20_000,
    });

    const importRow = await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("csv_imports")
          .select("id, filename, storage_path, total_rows")
          .eq("filename", filename)
          .maybeSingle();
        expect(error).toBeNull();
        return data ?? null;
      },
      { label: "canary csv_imports row", timeoutMs: 30_000 },
    );
    expect(importRow.storage_path).toBeTruthy();
    expect(importRow.total_rows).toBe(2);

    const job = await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("jobs")
          .select("id, status, total_items, succeeded_items, failed_items")
          .eq("related_import_id", importRow.id)
          .maybeSingle();
        expect(error).toBeNull();
        if (!data) return null;
        return ["completed", "partial", "failed"].includes(data.status)
          ? data
          : null;
      },
      { label: "terminal canary import job", timeoutMs: 75_000 },
    );
    expect(job.status).toBe("completed");
    expect(job.total_items).toBe(2);
    expect(job.succeeded_items).toBe(2);
    expect(job.failed_items).toBe(0);

    const imported = await pollUntil(
      async () => {
        const { data, error } = await supabase
          .from("properties")
          .select("id, address, source, status, equity_pct")
          .like("address", `${prefix}%`)
          .order("address", { ascending: true });
        expect(error).toBeNull();
        return (data ?? []).length === 2 ? data : null;
      },
      { label: "canary imported prospects", timeoutMs: 30_000 },
    );
    expect(imported.map((row) => row.source)).toEqual(["direct_mail", "direct_mail"]);
    expect(imported.map((row) => row.status)).toEqual(["prospect", "prospect"]);

    await page.goto("/properties");
    await page.getByTestId("prospects-search").fill(token);
    await expect(page.getByText(`${prefix} 401 Maple St`)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(`${prefix} 402 Maple St`)).toBeVisible();
    await expect(page.getByText(/Showing 1.*of 2 prospects/i)).toBeVisible();
  } finally {
    await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);
    await deleteCanaryImportArtifactsByFilename(supabase, filename);
  }
});
