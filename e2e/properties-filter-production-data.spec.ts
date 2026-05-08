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

    expect(baseline.count).toBe(2095);
    expect(verified.count).toBe(937);
    expect(unverified.count).toBe(1142);
    expect(invalid.count).toBe(16);
    expect(verified.count + unverified.count + invalid.count).toBe(
      baseline.count,
    );
    expect(verified.rows[0]).toContain("Verified");
    expect(unverified.rows[0]).toContain("Unverified");
    expect(invalid.rows[0]).toContain("Invalid");
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

    expect(vacant.count).toBe(28);
    expect(occupied.count).toBe(2067);
    expect(vacant.count + occupied.count).toBe(2095);
    expect(vacantVerified.count).toBe(vacant.count);
    expect(vacantUnverified.count).toBe(0);
    expect(vacant.rows[0]).toContain("Vacant");
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

    expect(highEquity.count).toBe(549);
    expect(lowEquity.count).toBe(45);
    expect(vacantHighEquity.count).toBe(0);
    expect(absentee.count).toBe(0);
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

    expect(newLead.count).toBe(12);
    expect(contacted.count).toBe(0);
    expect(newLeadVacant.count).toBe(0);
    expect(newLead.rows[0]).toContain("Contacted");
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
    const stacked = await readFilteredPage(page, [
      { id: "prod-stacked", kind: "list_count", range: { min: 2, max: null } },
    ]);

    expect(replied.count).toBe(43);
    expect(cold.count).toBe(0);
    expect(stacked.count).toBe(25);
    expect(stacked.rows[0]).toContain("Contacted");
  });
});
