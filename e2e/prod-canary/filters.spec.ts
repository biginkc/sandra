import { expect, test, type Page } from "@playwright/test";

import {
  deleteCanaryListsByName,
  deleteCanaryPropertiesByAddressPrefix,
  insertCanaryList,
  insertCanaryListMemberships,
  insertCanaryProspect,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
} from "./support";

async function addFilterBlock(page: Page, name: string) {
  await page.getByRole("button", { name: /Add Filter Block/i }).click();
  const search = page.getByPlaceholder(/search filters/i);
  await expect(search).toBeFocused();
  await search.fill(name);
  await page.getByRole("button", { name: new RegExp(`^${name}$`, "i") }).click();
}

test("production canary applies List + Equity + CASS filters to canary prospects", async ({
  page,
}, testInfo) => {
  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const prefix = `${env.label} Filter ${token}`;
  const listName = `${env.label} Filter List ${token}`;
  testInfo.annotations.push({ type: "runId", description: env.runId });

  await deleteCanaryListsByName(supabase, listName);
  await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);

  try {
    const list = await insertCanaryList(supabase, { name: listName });
    const target = await insertCanaryProspect(supabase, {
      address: `${prefix} Target 201 Oak St`,
      runId: env.runId,
      fields: {
        arv: 200_000,
        equity_estimate: 150_000,
        cass_status: "verified",
        is_vacant: true,
      },
    });
    const lowEquity = await insertCanaryProspect(supabase, {
      address: `${prefix} Low Equity 202 Oak St`,
      runId: env.runId,
      fields: {
        arv: 200_000,
        equity_estimate: 40_000,
        cass_status: "verified",
        is_vacant: true,
      },
    });
    const unverified = await insertCanaryProspect(supabase, {
      address: `${prefix} Unverified 203 Oak St`,
      runId: env.runId,
      fields: {
        arv: 200_000,
        equity_estimate: 150_000,
        cass_status: "unverified",
        is_vacant: true,
      },
    });
    const unlisted = await insertCanaryProspect(supabase, {
      address: `${prefix} Unlisted 204 Oak St`,
      runId: env.runId,
      fields: {
        arv: 200_000,
        equity_estimate: 150_000,
        cass_status: "verified",
        is_vacant: true,
      },
    });

    await insertCanaryListMemberships(supabase, {
      listId: list.id,
      propertyIds: [target.id, lowEquity.id, unverified.id],
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
    await expect(page.getByText(target.address)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(lowEquity.address)).toBeVisible();
    await expect(page.getByText(unverified.address)).toBeVisible();
    await expect(page.getByText(unlisted.address)).toBeVisible();

    await page.getByRole("button", { name: /^Filters$/i }).click();
    await addFilterBlock(page, "List");
    await page.getByLabel(list.name).check();
    await expect(page).toHaveURL(/\bfilters=/, { timeout: 10_000 });

    await addFilterBlock(page, "Equity %");
    await page.getByLabel(/Minimum equity percent/i).fill("50");
    await expect(page.getByTestId("prospects-skeleton-row").first()).toBeVisible({
      timeout: 5_000,
    });

    await addFilterBlock(page, "CASS");
    await page.getByRole("checkbox", { name: /^verified$/i }).check();

    await expect(page.getByText(target.address)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(lowEquity.address)).not.toBeVisible();
    await expect(page.getByText(unverified.address)).not.toBeVisible();
    await expect(page.getByText(unlisted.address)).not.toBeVisible();
    await expect(page.getByText(/Showing 1.*of 1 prospect/i)).toBeVisible();

    const filters = new URL(page.url()).searchParams.get("filters");
    expect(filters).toBeTruthy();
    const decoded = JSON.parse(filters as string) as {
      blocks: Array<Record<string, unknown>>;
    };
    expect(decoded.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "list",
          combinator: "any",
          values: [list.id],
        }),
        expect.objectContaining({
          kind: "equity_pct",
          range: { min: 50, max: null },
        }),
        expect.objectContaining({
          kind: "cass",
          combinator: "any",
          values: ["verified"],
        }),
      ]),
    );

    const { data, error } = await supabase
      .from("properties")
      .select("id, address, cass_status, equity_pct")
      .eq("id", target.id)
      .single();
    expect(error).toBeNull();
    expect(data?.address).toBe(target.address);
    expect(data?.cass_status).toBe("verified");
    expect(Number(data?.equity_pct)).toBeGreaterThanOrEqual(50);
  } finally {
    await deleteCanaryListsByName(supabase, listName);
    await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);
  }
});
