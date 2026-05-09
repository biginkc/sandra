import { test, expect } from "@playwright/test";
import {
  adminClient,
  resetTenantTables,
  seedList,
  seedProspects,
} from "./fixtures";

function encodedFilters(blocks: Array<Record<string, unknown>>) {
  return encodeURIComponent(JSON.stringify({ v: 1, blocks }));
}

function decodedFiltersFromUrl(url: string) {
  const raw = new URL(url).searchParams.get("filters");
  expect(raw).toBeTruthy();
  return JSON.parse(raw as string) as {
    v: number;
    blocks: Array<Record<string, unknown>>;
  };
}

async function expectUrlBlocks(
  page: import("@playwright/test").Page,
  assertion: (blocks: Array<Record<string, unknown>>) => void,
) {
  await expect
    .poll(
      () => {
        try {
          assertion(decodedFiltersFromUrl(page.url()).blocks);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function expectProspectTotal(
  page: import("@playwright/test").Page,
  expected: number,
) {
  if (expected === 0) {
    await expect(
      page.getByText(/No prospects yet\. Import a CSV to fill the data lake\./i),
    ).toBeVisible();
    return;
  }

  const pageEnd = Math.min(50, expected).toLocaleString();
  await expect(
    page.getByText(
      new RegExp(
        `Showing 1[–-]${pageEnd} of ${expected.toLocaleString()} prospects?`,
      ),
    ),
  ).toBeVisible();
}

async function addFilterBlock(page: import("@playwright/test").Page, name: string) {
  await page.getByRole("button", { name: /Add Filter Block/i }).click();
  const search = page.getByPlaceholder(/search filters/i);
  await expect(search).toBeFocused();
  await search.fill(name);
  await page.getByRole("button", { name: new RegExp(`^${name}$`, "i") }).click();
}

test.describe("Phase 05 Plan 09 — full feature flow", () => {
  test("page renders with filters param applied (the prod-bug repro)", async ({ page }) => {
    // This is the bug Jarrad hit: clicking a preset chip navigates to
    // /properties?filters=<json> and the page crashed during server render
    // with `query.order is not a function`. Repro it directly via URL.
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("response", async (r) => {
      if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`);
    });

    const filterState = {
      v: 1,
      blocks: [{ id: "test-vacancy-1", kind: "vacancy", tri: "yes" }],
    };
    const filtersParam = encodeURIComponent(JSON.stringify(filterState));

    await page.goto(`/properties?filters=${filtersParam}`);

    await expect(page.getByText(/Something went wrong/i)).not.toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByRole("button", { name: /^Filters/i })).toBeVisible();

    const activeBar = page.locator("[data-active-filters-chips]");
    await expect(activeBar).toBeVisible({ timeout: 8_000 });
    await expect(activeBar.locator("[data-chip-kind='vacancy']")).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("large List filter renders without a Bad Request", async ({ page }) => {
    test.setTimeout(60_000);
    const admin = adminClient();
    await resetTenantTables(admin);
    const prefix = `E2E Large List ${Date.now()}`;
    const listId = await seedList(admin, prefix);
    const seeded = await seedProspects(admin, 275, prefix);
    await admin.from("property_lists").insert(
      seeded.map((property) => ({
        property_id: property.id,
        list_id: listId,
      })),
    );
    const { count: expectedCount, error: expectedCountError } = await admin
      .from("properties")
      .select("id, property_lists!inner(list_id)", {
        count: "exact",
        head: true,
      })
      .is("deleted_at", null)
      .eq("status", "prospect")
      .eq("property_lists.list_id", listId);
    expect(expectedCountError).toBeNull();
    const { count: expectedNotCount, error: expectedNotCountError } = await admin
      .from("properties")
      .select("id, list_exclusion:property_lists(list_id)", {
        count: "exact",
        head: true,
      })
      .is("deleted_at", null)
      .eq("status", "prospect")
      .eq("list_exclusion.list_id", listId)
      .is("list_exclusion", null);
    expect(expectedNotCountError).toBeNull();

    const errors: string[] = [];
    page.on("response", (response) => {
      if (response.status() >= 400) {
        errors.push(`${response.status()} ${response.url()}`);
      }
    });

    try {
      await page.goto(
        `/properties?filters=${encodedFilters([
          {
            id: "large-list",
            kind: "list",
            combinator: "any",
            values: [listId],
          },
        ])}`,
      );

      await expect(
        page.getByText(/Failed to load prospects: Bad Request/i),
      ).not.toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(prefix).first()).toBeVisible({
        timeout: 10_000,
      });
      await expectProspectTotal(page, expectedCount ?? 0);
      expect(errors.filter((error) => error.includes("/properties"))).toEqual([]);

      await page.goto(
        `/properties?filters=${encodedFilters([
          {
            id: "large-list-not",
            kind: "list",
            combinator: "not",
            values: [listId],
          },
        ])}`,
      );
      await expect(
        page.getByText(/Failed to load prospects: Bad Request/i),
      ).not.toBeVisible({ timeout: 10_000 });
      await expectProspectTotal(page, expectedNotCount ?? 0);
      expect(errors.filter((error) => error.includes("/properties"))).toEqual([]);
    } finally {
      await admin.from("property_lists").delete().eq("list_id", listId);
      await admin.from("properties").delete().like("address", `${prefix}%`);
      await admin.from("lists").delete().eq("id", listId);
    }
  });

  test("base preset chip click toggles URL and aria-pressed", async ({ page }) => {
    await page.goto("/properties");
    await page.waitForLoadState("networkidle");
    const bar = page.locator("[data-quick-filters-bar]");
    const vacantChip = bar.locator("[data-quick-filter-chip][data-preset-name='Vacant']");
    await expect(vacantChip).toBeVisible({ timeout: 10_000 });

    await expect(vacantChip).toHaveAttribute("aria-pressed", "false");

    await vacantChip.click();
    await expect(page).toHaveURL(/\bfilters=/, { timeout: 10_000 });
    await expect(vacantChip).toHaveAttribute("aria-pressed", "true");

    const activeBar = page.locator("[data-active-filters-chips]");
    await expect(activeBar).toBeVisible({ timeout: 5_000 });
    await expect(activeBar.locator("[data-chip-kind='vacancy']")).toBeVisible();

    await page.screenshot({ path: "/tmp/plan-09-preset-applied.png", fullPage: true });
  });

  test("opening drawer + adding Vacancy=Yes block updates filters immediately", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

    await page.goto("/properties");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /^Filters$/i }).click();
    await expect(
      page.getByText(/Add a filter to slice your prospects/i),
    ).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Show .* prospects$/i }),
    ).not.toBeVisible();
    await expect(page.locator("[data-slot='sheet-overlay']")).toHaveClass(
      /bg-transparent/,
    );
    await expect(page.locator("[data-slot='sheet-overlay']")).toHaveClass(
      /backdrop-blur-none/,
    );
    await expect(page.getByTestId("prospects-table-container")).toBeVisible();

    await page.getByRole("button", { name: /Add Filter Block/i }).click();
    const search = page.getByPlaceholder(/search filters/i);
    await expect(search).toBeFocused();
    await search.fill("vacan");

    await page.getByRole("button", { name: /^Vacancy$/i }).click();

    const yesRadio = page.getByRole("radio", { name: /yes \(vacant\)/i });
    await expect(yesRadio).toBeVisible({ timeout: 5_000 });
    // base-ui radio: .check() rejects (custom widget); .click() works
    await yesRadio.click();
    await expect(yesRadio).toBeChecked({ timeout: 250 });
    await expect(page.getByTestId("prospects-skeleton-row").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Show .* prospects$/i }),
    ).not.toBeVisible();

    await page.screenshot({ path: "/tmp/plan-09-drawer-vacancy.png", fullPage: true });

    await expect(page).toHaveURL(/\bfilters=/, { timeout: 10_000 });
    const activeBar = page.locator("[data-active-filters-chips]");
    await expect(activeBar.locator("[data-chip-kind='vacancy']")).toBeVisible({
      timeout: 10_000,
    });

    expect(errors).toEqual([]);
  });

  test("clicking active preset chip clears the filter", async ({ page }) => {
    await page.goto("/properties");
    await page.waitForLoadState("networkidle");
    const bar = page.locator("[data-quick-filters-bar]");
    const vacantChip = bar.locator("[data-quick-filter-chip][data-preset-name='Vacant']");
    await expect(vacantChip).toBeVisible({ timeout: 10_000 });

    await vacantChip.click();
    await expect(page).toHaveURL(/\bfilters=/, { timeout: 10_000 });
    await expect(vacantChip).toHaveAttribute("aria-pressed", "true");

    await vacantChip.click();
    await expect(page).not.toHaveURL(/\bfilters=/, { timeout: 10_000 });
    await expect(vacantChip).toHaveAttribute("aria-pressed", "false");
  });

  test("drawer hydrates multiple URL blocks into real controls", async ({ page }) => {
    const filtersParam = encodedFilters([
      { id: "hydrate-vacancy", kind: "vacancy", tri: "yes" },
      {
        id: "hydrate-cass",
        kind: "cass",
        combinator: "any",
        values: ["unverified"],
      },
    ]);

    await page.goto(`/properties?search=drawer-hydrate&filters=${filtersParam}`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /^Filters \(2\)$/i }).click();

    await expect(page.locator("[data-block-row][data-kind='vacancy']")).toBeVisible();
    await expect(page.locator("[data-block-row][data-kind='cass']")).toBeVisible();
    await expect(page.getByRole("radio", { name: /yes \(vacant\)/i })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /^unverified$/i })).toBeChecked();
  });

  test("drawer can compose Vacancy + CASS filters and preserve unrelated URL params", async ({
    page,
  }) => {
    await page.goto("/properties?search=drawer-combo");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /^Filters$/i }).click();

    await addFilterBlock(page, "Vacancy");
    await page.getByRole("radio", { name: /yes \(vacant\)/i }).click();
    await expect(page.getByRole("radio", { name: /yes \(vacant\)/i })).toBeChecked({
      timeout: 250,
    });

    await addFilterBlock(page, "CASS");
    await page.getByRole("checkbox", { name: /^unverified$/i }).click();
    await expect(page.getByRole("checkbox", { name: /^unverified$/i })).toBeChecked({
      timeout: 250,
    });

    await expect(page).toHaveURL(/\bfilters=/, { timeout: 10_000 });
    const url = page.url();
    expect(new URL(url).searchParams.get("search")).toBe("drawer-combo");

    await expectUrlBlocks(page, (blocks) => {
      expect(blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "vacancy", tri: "yes" }),
          expect.objectContaining({
            kind: "cass",
            combinator: "any",
            values: ["unverified"],
          }),
        ]),
      );
    });
  });

  test("removing one hydrated drawer block keeps the remaining block", async ({ page }) => {
    const filtersParam = encodedFilters([
      { id: "remove-vacancy", kind: "vacancy", tri: "yes" },
      {
        id: "remove-cass",
        kind: "cass",
        combinator: "any",
        values: ["verified"],
      },
    ]);

    await page.goto(`/properties?search=drawer-remove&filters=${filtersParam}`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /^Filters \(2\)$/i }).click();
    await page.getByRole("button", { name: /Remove Vacancy filter/i }).click();

    await expect(page).toHaveURL(/\bfilters=/, { timeout: 10_000 });
    expect(new URL(page.url()).searchParams.get("search")).toBe("drawer-remove");

    await expectUrlBlocks(page, (blocks) => {
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual(
        expect.objectContaining({
          id: "remove-cass",
          kind: "cass",
          combinator: "any",
          values: ["verified"],
        }),
      );
    });
  });

  test("removing the last drawer block clears only filters from the URL", async ({ page }) => {
    const filtersParam = encodedFilters([
      { id: "last-absentee", kind: "absentee", tri: "yes" },
    ]);

    await page.goto(`/properties?search=drawer-last&filters=${filtersParam}`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /^Filters \(1\)$/i }).click();
    await page.getByRole("button", { name: /Remove Absentee Owner filter/i }).click();

    await expect(page).not.toHaveURL(/\bfilters=/, { timeout: 10_000 });
    expect(new URL(page.url()).searchParams.get("search")).toBe("drawer-last");
  });
});
