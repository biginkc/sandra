import { expect, test, type Page } from "@playwright/test";

import {
  deleteCanaryListsByName,
  deleteCanaryPropertiesByAddressPrefix,
  insertCanaryList,
  insertCanaryListMemberships,
  insertCanaryProspects,
  requireProdCanaryEnv,
  requireProdCanarySupabase,
} from "./support";

const LARGE_LIST_SIZE = 275;

async function addFilterBlock(page: Page, name: string) {
  await page.getByRole("button", { name: /Add Filter Block/i }).click();
  const search = page.getByPlaceholder(/search filters/i);
  await expect(search).toBeFocused();
  await search.fill(name);
  await page.getByRole("button", { name: new RegExp(`^${name}$`, "i") }).click();
}

test("production canary filters a large canary-owned list without Bad Request", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);

  const env = requireProdCanaryEnv();
  const supabase = requireProdCanarySupabase();
  const token = env.runId.replace(/[^a-zA-Z0-9-]/g, "-");
  const prefix = `${env.label} Large List ${token}`;
  const listName = `${env.label} Large Filter List ${token}`;
  const pageErrors: string[] = [];
  testInfo.annotations.push({ type: "runId", description: env.runId });

  page.on("response", (response) => {
    if (response.status() >= 400 && response.url().includes("/properties")) {
      pageErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  await deleteCanaryListsByName(supabase, listName);
  await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);

  try {
    const list = await insertCanaryList(supabase, { name: listName });
    const properties = await insertCanaryProspects(
      supabase,
      Array.from({ length: LARGE_LIST_SIZE }, (_, index) => ({
        address: `${prefix} ${String(index + 1).padStart(3, "0")} Cypress Ave`,
        runId: env.runId,
        fields: {
          cass_status: "verified",
          is_vacant: index % 2 === 0,
        },
      })),
    );
    await insertCanaryListMemberships(supabase, {
      listId: list.id,
      propertyIds: properties.map((property) => property.id),
    });

    const { count, error } = await supabase
      .from("properties")
      .select("id, property_lists!inner(list_id)", {
        count: "exact",
        head: true,
      })
      .eq("property_lists.list_id", list.id)
      .is("deleted_at", null)
      .eq("status", "prospect");
    expect(error).toBeNull();
    expect(count).toBe(LARGE_LIST_SIZE);

    await page.goto("/properties");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId("prospects-table-container")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole("button", { name: /^Filters$/i }).click();
    await addFilterBlock(page, "List");
    await page.getByLabel(list.name).check();

    await expect(
      page.getByText(/Failed to load prospects: Bad Request/i),
    ).not.toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(new RegExp(`Showing 1.*50 of ${LARGE_LIST_SIZE} prospects`))).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(prefix).first()).toBeVisible();

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
      ]),
    );
    expect(pageErrors).toEqual([]);
  } finally {
    await deleteCanaryListsByName(supabase, listName);
    await deleteCanaryPropertiesByAddressPrefix(supabase, prefix);
  }
});
