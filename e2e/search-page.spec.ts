import { expect, test } from "@playwright/test";

import { adminClient, DEFAULT_ORG_ID, ensureTestUser, resetTenantTables } from "./fixtures";

// Search page (formerly Prospects). Three specs only, per the stress plan:
//   1. type -> 250ms debounce -> ?search= -> rows + count
//   2. search + outreach_dispo chip + pagination
//   3. /search redirects to /properties and keeps the query string
// Runs against the E2E target (resetTenantTables is guarded by the E2E safety
// checks). Needs the migration with public.search_properties applied.

let phoneSeq = 0;
const SURNAME = `Zyxqwerty${Date.now().toString(36)}`;

async function seed(count: number, opts: { dispo?: string | null; status?: string } = {}) {
  const admin = adminClient();
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const { data: contact, error: contactError } = await admin
      .from("contacts")
      .insert({
        org_id: DEFAULT_ORG_ID,
        first_name: "Pat",
        last_name: SURNAME,
        phone_1: `+1816555${String(1000 + phoneSeq++).padStart(4, "0")}`,
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    if (contactError || !contact) throw contactError ?? new Error("contact insert failed");
    rows.push({
      org_id: DEFAULT_ORG_ID,
      address: `${100 + i} Search E2E Ln`,
      city: "Kansas City",
      state: "MO",
      zip: "64151",
      status: opts.status ?? "prospect",
      cass_status: "verified",
      outreach_dispo: opts.dispo ?? null,
      homeowner_contact_id: contact.id,
    });
  }
  const { error } = await admin.from("properties").insert(rows);
  if (error) throw error;
}

test.describe("Search page", () => {
  test.beforeEach(async () => {
    const admin = adminClient();
    await resetTenantTables(admin);
    await ensureTestUser(admin);
  });

  test("typing a homeowner name debounces into ?search= and shows matching leads and prospects", async ({
    page,
  }) => {
    await seed(2, { status: "prospect" });
    await seed(1, { status: "new_lead" });

    await page.goto("/properties");
    await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();

    const box = page.getByTestId("prospects-search");
    // The dev server may still be hydrating on the first compile: retry the
    // type-and-debounce until the input is wired to the URL.
    await expect(async () => {
      await box.fill("");
      await box.fill(SURNAME);
      await expect(page).toHaveURL(new RegExp(`search=${SURNAME}`), { timeout: 2_000 });
    }).toPass({ timeout: 25_000 });

    await expect(page.getByTestId("prospects-result-count")).toContainText("of 3");
    // Both a prospect and a lead are listed, and the Status column tells them apart.
    await expect(page.getByText("New lead").first()).toBeVisible();
    await expect(page.getByText("Prospect", { exact: true }).first()).toBeVisible();
  });

  test("search ANDs with an outreach outcome filter and paginates", async ({ page }) => {
    await seed(52, { dispo: "wrong_number" });
    await seed(3, { dispo: null });

    const filters = encodeURIComponent(
      JSON.stringify({
        v: 1,
        blocks: [{ id: "dispo-1", kind: "outreach_dispo", combinator: "any", values: ["wrong_number"] }],
      }),
    );
    await page.goto(`/properties?search=${SURNAME}&filters=${filters}`);
    await expect(page.getByTestId("prospects-result-count")).toContainText("of 52");

    await page.goto(`/properties?search=${SURNAME}&filters=${filters}&page=2`);
    await expect(page.getByTestId("prospects-result-count")).toContainText("Showing 51");
    await expect(page.getByTestId("prospects-result-count")).toContainText("of 52");
  });

  test("/search redirects to /properties and keeps the query string", async ({ page }) => {
    await seed(1);
    await page.goto(`/search?search=${SURNAME}`);
    await expect(page).toHaveURL(new RegExp(`/properties\\?search=${SURNAME}`));
    await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
    await expect(page.getByTestId("prospects-result-count")).toContainText("of 1");
  });
});
