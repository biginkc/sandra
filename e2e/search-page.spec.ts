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

async function seed(
  count: number,
  opts: { dispo?: string | null; status?: string; surname?: string; dnc?: boolean } = {},
) {
  const admin = adminClient();
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const { data: contact, error: contactError } = await admin
      .from("contacts")
      .insert({
        org_id: DEFAULT_ORG_ID,
        first_name: "Pat",
        last_name: opts.surname ?? SURNAME,
        do_not_contact: opts.dnc ?? false,
        phone_1: `+1816555${String(1000 + phoneSeq++).padStart(4, "0")}`,
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    if (contactError || !contact) throw contactError ?? new Error("contact insert failed");
    rows.push({
      org_id: DEFAULT_ORG_ID,
      address: `${100 + i} ${opts.status ?? "prospect"}${opts.dnc ? "-dnc" : ""} ${opts.surname ?? "Search"} E2E Ln`,
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

  async function sideEffectCounts() {
    const admin = adminClient();
    const count = async (table: "campaigns" | "messages" | "dialer_batches" | "dialer_batch_items") => {
      const { count: c, error } = await admin.from(table).select("id", { count: "exact", head: true });
      if (error) throw error;
      return c ?? 0;
    };
    return {
      campaigns: await count("campaigns"),
      messages: await count("messages"),
      dialer_batches: await count("dialer_batches"),
      dialer_batch_items: await count("dialer_batch_items"),
    };
  }

  async function openFrom(page: import("@playwright/test").Page, term: string) {
    await page.goto(`/properties?search=${term}`);
    await expect(page.getByTestId("prospects-result-count")).toBeVisible();
  }

  test("select-all-matching modals report skipped leads and exclude leads and DNC from eligible", async ({
    page,
  }) => {
    const term = `Skipmodal${Date.now().toString(36)}`;
    await seed(52, { surname: term });
    await seed(2, { surname: term, status: "new_lead" });
    await seed(1, { surname: term, dnc: true });
    const before = await sideEffectCounts();
    await openFrom(page, term);
    await expect(page.getByTestId("prospects-result-count")).toContainText("of 55");

    await page.getByRole("checkbox", { name: "Select all prospects on this page" }).click();
    await page.getByTestId("select-all-across-pages").click();
    const banner = page.getByTestId("select-all-banner");
    await expect(banner).toContainText("2 leads skipped");
    await expect(banner).toContainText("DNC locked and excluded");

    await page.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Bulk SMS" }).click();
    const smsDialog = page.getByRole("dialog");
    await expect(smsDialog.getByRole("heading")).toContainText("Bulk SMS — 52 prospects");
    const assessment = smsDialog.getByTestId("line-type-assessment");
    await assessment.scrollIntoViewIfNeeded();
    await expect(assessment).toContainText("Who gets texted");
    await expect(smsDialog.getByTestId("bulk-sms-skipped-leads")).toBeVisible();
    await expect(smsDialog.getByTestId("bulk-sms-skipped-leads")).toContainText("2 leads skipped");
    await smsDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Create dialer batch" }).click();
    const batchDialog = page.getByRole("dialog");
    await expect(batchDialog.getByTestId("batch-skipped-leads")).toBeVisible();
    await expect(batchDialog.getByTestId("batch-skipped-leads")).toContainText("2 leads skipped");
    await expect(batchDialog).toContainText("52 eligible from current filters");
    await expect(batchDialog).toContainText("1 DNC locked and excluded");
    await batchDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    expect(await sideEffectCounts()).toEqual(before);
  });

  test("checkbox selection of one lead and one prospect reports one skipped lead in both modals", async ({
    page,
  }) => {
    const term = `Skipbox${Date.now().toString(36)}`;
    await seed(1, { surname: term });
    await seed(1, { surname: term, status: "new_lead" });
    const before = await sideEffectCounts();
    // The Bulk SMS dialog is taller than a 720px viewport and its Cancel button
    // cannot be scrolled into view there, so use a tall viewport for this spec.
    await page.setViewportSize({ width: 1280, height: 1600 });

    await openFrom(page, term);
    await expect(page.getByTestId("prospects-result-count")).toContainText("of 2");
    await page.getByRole("checkbox", { name: /^Select 100 prospect / }).click();
    await page.getByRole("checkbox", { name: /^Select 100 new_lead / }).click();

    await page.getByRole("button", { name: /Actions for 2 selected/ }).click();
    await page.getByRole("menuitem", { name: "Bulk SMS" }).click();
    const smsDialog = page.getByRole("dialog");
    await expect(smsDialog.getByTestId("bulk-sms-skipped-leads")).toContainText("1 lead skipped");
    await smsDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: /Actions for 2 selected/ }).click();
    await page.getByRole("menuitem", { name: "Create dialer batch" }).click();
    const batchDialog = page.getByRole("dialog");
    await expect(batchDialog.getByTestId("batch-skipped-leads")).toContainText("1 lead skipped");
    await batchDialog.getByRole("button", { name: "Cancel" }).click();

    expect(await sideEffectCounts()).toEqual(before);
  });

  test("Bulk SMS and dialer dialogs stay usable at 1280x720 (Cancel reachable, body scrolls)", async ({ page }) => {
    const term = `Skipvp${Date.now().toString(36)}`;
    await seed(2, { surname: term });
    await page.setViewportSize({ width: 1280, height: 720 });
    await openFrom(page, term);
    await page.getByRole("checkbox", { name: "Select all prospects on this page" }).click();

    for (const item of ["Bulk SMS", "Create dialer batch"]) {
      await page.getByRole("button", { name: /Actions for/ }).click();
      await page.getByRole("menuitem", { name: item }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(720);
      const cancel = dialog.getByRole("button", { name: "Cancel" });
      await expect(cancel).toBeInViewport();
      await cancel.click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  });
});
