import { expect, test, type Page } from "@playwright/test";

const RUN_PROD_FILTER_DATA_TESTS =
  process.env.RUN_PROD_FILTER_DATA_TESTS === "1";

const PROD_FILTER_BASE_URL =
  process.env.PROD_FILTER_BASE_URL ?? "https://sandra-sooty.vercel.app";

function filterParam(blocks: Array<Record<string, unknown>>) {
  return encodeURIComponent(JSON.stringify({ v: 1, blocks }));
}

function filterUrl(blocks: Array<Record<string, unknown>>) {
  return `/properties?filters=${filterParam(blocks)}`;
}

function parseProspectCount(header: string) {
  if (/No prospects/i.test(header)) return 0;
  const match = header.match(/of\s+([\d,]+)\s+prospect/i);
  if (!match) throw new Error(`Could not parse prospect count from: ${header}`);
  return Number(match[1].replace(/,/g, ""));
}

async function signIn(page: Page) {
  if (!process.env.PROD_EMAIL || !process.env.PROD_PASSWORD) {
    throw new Error("Set PROD_EMAIL and PROD_PASSWORD to run prod filter tests.");
  }

  await page.goto("/login");
  await page.locator("input[name=email]").fill(process.env.PROD_EMAIL);
  await page.locator("input[name=password]").fill(process.env.PROD_PASSWORD);
  await Promise.all([
    page.waitForURL(/\/dashboard/, { timeout: 15_000 }),
    page.getByRole("button", { name: /sign in/i }).click(),
  ]);
}

async function readFilteredPage(
  page: Page,
  blocks: Array<Record<string, unknown>> = [],
) {
  await page.goto(blocks.length > 0 ? filterUrl(blocks) : "/properties");
  await page.getByRole("heading", { name: "Prospects" }).waitFor();
  await expect(
    page.getByText(/Failed to load prospects: Bad Request/i),
  ).not.toBeVisible({ timeout: 5_000 });

  const header = (await page.locator("main p").first().textContent()) ?? "";
  const active = await page
    .locator("[data-active-filters-chips]")
    .textContent({ timeout: 1_000 })
    .catch(() => "");
  const rows = await page.locator("tbody tr").evaluateAll((trs) =>
    trs.slice(0, 3).map((tr) => tr.textContent?.replace(/\s+/g, " ").trim()),
  );

  return {
    active: active?.replace(/\s+/g, " ").trim() ?? "",
    count: parseProspectCount(header),
    header,
    rows,
  };
}

test.describe("Production data filter smoke", () => {
  test.skip(!RUN_PROD_FILTER_DATA_TESTS, "Set RUN_PROD_FILTER_DATA_TESTS=1.");
  test.use({ baseURL: PROD_FILTER_BASE_URL });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("CASS filters partition the current production prospect set", async ({
    page,
  }) => {
    const baseline = await readFilteredPage(page);
    const verified = await readFilteredPage(page, [
      {
        id: "prod-cass-verified",
        kind: "cass",
        combinator: "any",
        values: ["verified"],
      },
    ]);
    const unverified = await readFilteredPage(page, [
      {
        id: "prod-cass-unverified",
        kind: "cass",
        combinator: "any",
        values: ["unverified"],
      },
    ]);
    const invalid = await readFilteredPage(page, [
      {
        id: "prod-cass-invalid",
        kind: "cass",
        combinator: "any",
        values: ["invalid"],
      },
    ]);
    const ambiguous = await readFilteredPage(page, [
      {
        id: "prod-cass-ambiguous",
        kind: "cass",
        combinator: "any",
        values: ["ambiguous"],
      },
    ]);

    expect(baseline.count).toBeGreaterThan(0);
    expect(verified.count + unverified.count + invalid.count + ambiguous.count).toBe(
      baseline.count,
    );
    if (verified.count > 0) expect(verified.rows[0]).toContain("Verified");
    if (unverified.count > 0) expect(unverified.rows[0]).toContain("Unverified");
    if (invalid.count > 0) expect(invalid.rows[0]).toContain("Invalid");
    if (ambiguous.count > 0) expect(ambiguous.rows[0]).toContain("Ambiguous");
  });

  test("vacancy filters match production vacancy reality", async ({ page }) => {
    const vacant = await readFilteredPage(page, [
      { id: "prod-vacant", kind: "vacancy", tri: "yes" },
    ]);
    const occupied = await readFilteredPage(page, [
      { id: "prod-occupied", kind: "vacancy", tri: "no" },
    ]);
    const vacantVerified = await readFilteredPage(page, [
      { id: "prod-vacant", kind: "vacancy", tri: "yes" },
      {
        id: "prod-cass-verified",
        kind: "cass",
        combinator: "any",
        values: ["verified"],
      },
    ]);
    const vacantUnverified = await readFilteredPage(page, [
      { id: "prod-vacant", kind: "vacancy", tri: "yes" },
      {
        id: "prod-cass-unverified",
        kind: "cass",
        combinator: "any",
        values: ["unverified"],
      },
    ]);

    expect(vacant.count + occupied.count).toBeGreaterThan(0);
    expect(vacantVerified.count).toBeLessThanOrEqual(vacant.count);
    expect(vacantUnverified.count).toBeLessThanOrEqual(vacant.count);
    if (vacant.count > 0) expect(vacant.rows[0]).toContain("Vacant");
  });

  test("equity and absentee combinations cover current edge cases", async ({
    page,
  }) => {
    const highEquity = await readFilteredPage(page, [
      {
        id: "prod-high-equity",
        kind: "equity_pct",
        range: { min: 40, max: null },
      },
    ]);
    const lowEquity = await readFilteredPage(page, [
      {
        id: "prod-low-equity",
        kind: "equity_pct",
        range: { min: null, max: 20 },
      },
    ]);
    const vacantHighEquity = await readFilteredPage(page, [
      { id: "prod-vacant", kind: "vacancy", tri: "yes" },
      {
        id: "prod-high-equity",
        kind: "equity_pct",
        range: { min: 40, max: null },
      },
    ]);
    const absentee = await readFilteredPage(page, [
      { id: "prod-absentee", kind: "absentee", tri: "yes" },
    ]);

    expect(vacantHighEquity.count).toBeLessThanOrEqual(highEquity.count);
    expect(vacantHighEquity.count).toBeLessThanOrEqual(
      (await readFilteredPage(page, [
        { id: "prod-vacant", kind: "vacancy", tri: "yes" },
      ])).count,
    );
    expect(lowEquity.count).toBeGreaterThanOrEqual(0);
    expect(absentee.count).toBeGreaterThanOrEqual(0);
  });

  test("pipeline status block broadens beyond the default prospect status", async ({
    page,
  }) => {
    const newLead = await readFilteredPage(page, [
      {
        id: "prod-new-lead",
        kind: "pipeline_status",
        combinator: "any",
        values: ["new_lead"],
      },
    ]);
    const contacted = await readFilteredPage(page, [
      {
        id: "prod-contacted",
        kind: "pipeline_status",
        combinator: "any",
        values: ["contacted"],
      },
    ]);
    const newLeadVacant = await readFilteredPage(page, [
      {
        id: "prod-new-lead",
        kind: "pipeline_status",
        combinator: "any",
        values: ["new_lead"],
      },
      { id: "prod-vacant", kind: "vacancy", tri: "yes" },
    ]);

    expect(newLead.count).toBeGreaterThanOrEqual(0);
    expect(contacted.count).toBeGreaterThanOrEqual(0);
    expect(newLeadVacant.count).toBeLessThanOrEqual(newLead.count);
  });

  test("engagement and stacked presets have production-backed targets", async ({
    page,
  }) => {
    const replied = await readFilteredPage(page, [
      {
        id: "prod-replied",
        kind: "engagement",
        combinator: "any",
        values: ["replied"],
      },
    ]);
    const cold = await readFilteredPage(page, [
      {
        id: "prod-never-contacted",
        kind: "engagement",
        combinator: "any",
        values: ["never_contacted"],
      },
    ]);
    const engaged = await readFilteredPage(page, [
      {
        id: "prod-engaged",
        kind: "engagement",
        combinator: "any",
        values: ["replied", "attempted"],
      },
    ]);
    const stacked = await readFilteredPage(page, [
      { id: "prod-stacked", kind: "list_count", range: { min: 2, max: null } },
    ]);

    const baseline = await readFilteredPage(page);
    expect(replied.count).toBeLessThanOrEqual(baseline.count);
    expect(cold.count).toBeLessThanOrEqual(baseline.count);
    expect(engaged.count).toBeLessThanOrEqual(baseline.count);
    expect(stacked.count).toBeLessThanOrEqual(baseline.count);
  });

  test("zero-result prefetch filters render empty state without Bad Request", async ({
    page,
  }) => {
    const attempted = await readFilteredPage(page, [
      {
        id: "prod-attempted",
        kind: "engagement",
        combinator: "any",
        values: ["attempted"],
      },
    ]);
    const openTasks = await readFilteredPage(page, [
      { id: "prod-open-tasks", kind: "has_open_tasks", tri: "yes" },
    ]);

    expect(attempted.count).toBeGreaterThanOrEqual(0);
    expect(openTasks.count).toBeGreaterThanOrEqual(0);
  });
});
