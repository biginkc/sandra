import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

import type { BlockStack, FilterState } from "../src/lib/prospects/filter-schema";
import type { Database } from "../src/lib/supabase/types";

type MatrixRow = {
  filter: string;
  scenario: string;
  blocks: BlockStack;
  expected: number;
};

type UiResult = {
  filter: string;
  scenario: string;
  expected: number;
  rendered: number | null;
  pass: boolean;
  error: string | null;
};

type UiScenarioOptions = {
  verifyDrawer?: boolean;
};

const MATRIX_PATH = path.resolve(
  __dirname,
  "../docs/qa/properties-filter-characterization/pass1-production-matrix.json",
);
const OUT_DIR = path.resolve(
  __dirname,
  "../test-results/properties-filter-characterization",
);
const ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const TARGET_LABEL = (process.env.FILTER_UI_TARGET ?? "prod").replace(
  /[^a-zA-Z0-9_-]/g,
  "-",
);
const AUTH_FILE =
  process.env.PROPERTIES_FILTER_AUTH_FILE ??
  `test-results/properties-filter-characterization/auth-${TARGET_LABEL}.json`;
const DEFAULT_COUNT_LIMIT = 100;

test.describe.configure({ mode: "serial" });

test.afterAll(() => {
  fs.rmSync(path.resolve(__dirname, "..", AUTH_FILE), { force: true });
});

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }
  throw new Error(
    `Missing required env var (${names.join(" or ")}). Run: source /tmp/sandra-prod.env`,
  );
}

function uiTargetLabel(): string {
  return TARGET_LABEL;
}

function shouldAssertGreen(): boolean {
  return process.env.EXPECT_PROPERTIES_FILTER_UI_PASS !== "0";
}

function renderTimeoutMs(): number {
  return Number(
    process.env.FILTER_UI_RENDER_TIMEOUT_MS ?? (shouldAssertGreen() ? 30_000 : 10_000),
  );
}

function loadMatrix(): MatrixRow[] {
  const raw = JSON.parse(fs.readFileSync(MATRIX_PATH, "utf8")) as {
    results: MatrixRow[];
  };
  return raw.results.filter((row) => Array.isArray(row.blocks));
}

function selectCountScenarios(rows: MatrixRow[]): MatrixRow[] {
  const limit = Number(
    process.env.FILTER_UI_SCENARIO_LIMIT ?? DEFAULT_COUNT_LIMIT,
  );
  const byFilter = new Map<string, MatrixRow[]>();
  for (const row of rows) {
    if (!byFilter.has(row.filter)) byFilter.set(row.filter, []);
    byFilter.get(row.filter)!.push(row);
  }

  const selected: MatrixRow[] = [];
  const groups = Array.from(byFilter.values());
  for (let depth = 0; selected.length < limit; depth += 1) {
    let added = false;
    for (const group of groups) {
      if (selected.length >= limit) break;
      const row = group[depth];
      if (!row) continue;
      selected.push(row);
      added = true;
    }
    if (!added) break;
  }

  const critical = rows.find(
    (row) =>
      row.filter === "list_count" &&
      row.scenario.includes('"min":null') &&
      row.scenario.includes('"max":1'),
  );
  if (critical && !selected.includes(critical)) {
    selected.splice(Math.max(0, selected.length - 1), 1, critical);
  }

  return selected;
}

function selectRehydrationScenarios(rows: MatrixRow[]): MatrixRow[] {
  const seen = new Set<string>();
  const selected: MatrixRow[] = [];
  for (const row of rows) {
    if (row.blocks.length !== 1) continue;
    const kind = row.blocks[0].kind;
    if (seen.has(kind)) continue;
    seen.add(kind);
    selected.push(row);
  }
  return selected;
}

function hrefForBlocks(blocks: BlockStack): string {
  const params = new URLSearchParams();
  if (blocks.length > 0) {
    const state: FilterState = { v: 1, blocks };
    params.set("filters", JSON.stringify(state));
  }
  return params.size > 0 ? `/properties?${params.toString()}` : "/properties";
}

function parseRenderedCount(text: string): number | null {
  if (text.includes("No prospects")) return 0;
  const match = text.match(/Showing\s+[\d,]+(?:[\u2013-][\d,]+)?\s+of\s+([\d,]+)/);
  if (!match) return null;
  return Number(match[1].replaceAll(",", ""));
}

async function renderedCount(page: Page): Promise<number> {
  const timeout = renderTimeoutMs();
  const table = page.getByTestId("prospects-table-container");
  await expect(table).toBeVisible({ timeout });
  await expect(page.getByTestId("prospects-skeleton-row")).toHaveCount(0, {
    timeout,
  });
  const countLabel = page.getByTestId("prospects-result-count");
  let text = "";
  if ((await countLabel.count()) > 0) {
    await expect(countLabel).toBeVisible({ timeout });
    text = (await countLabel.textContent()) ?? "";
  } else {
    text = await page.locator("body").innerText({ timeout });
  }
  const parsed = parseRenderedCount(text);
  if (parsed == null) {
    throw new Error(`Could not parse rendered count from footer text: ${text.slice(0, 200)}`);
  }
  return parsed;
}

async function evaluateUiScenario(
  page: Page,
  row: MatrixRow,
  options: UiScenarioOptions = {},
): Promise<UiResult> {
  let rendered: number | null = null;
  let error: string | null = null;
  try {
    await page.goto(hrefForBlocks(row.blocks), { waitUntil: "domcontentloaded" });
    rendered = await renderedCount(page);
    if (options.verifyDrawer) {
      await page.getByRole("button", { name: /^Filters/i }).click();
      await expect(page.locator("[data-block-row]")).toHaveCount(row.blocks.length);
      for (const block of row.blocks) {
        await expect(
          page.locator(`[data-block-row][data-kind="${block.kind}"]`),
        ).toHaveCount(1);
      }
      await page.keyboard.press("Escape");
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    filter: row.filter,
    scenario: row.scenario,
    expected: row.expected,
    rendered,
    pass: error == null && rendered === row.expected,
    error,
  };
}

async function evaluateUiRows(
  page: Page,
  rows: MatrixRow[],
  options: UiScenarioOptions = {},
): Promise<UiResult[]> {
  const results: UiResult[] = [];
  for (const [index, row] of rows.entries()) {
    results.push(await evaluateUiScenario(page, row, options));
    if ((index + 1) % 10 === 0 || index + 1 === rows.length) {
      console.log(
        `[pass2:${uiTargetLabel()}] ${index + 1}/${rows.length} scenarios, failed=${
          results.filter((result) => !result.pass).length
        }`,
      );
    }
  }
  return results;
}

async function checkSavePresetToggle(page: Page): Promise<void> {
  const toggle = page.getByTestId("save-preset-toggle");
  if ((await toggle.count()) > 0) {
    await toggle.check();
    return;
  }
  await page.getByLabel(/Save as new preset/i).check();
}

function writeUiResults(
  filename: string,
  payload: Record<string, unknown>,
): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, filename),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        target: uiTargetLabel(),
        baseURL: process.env.FILTER_UI_BASE_URL ?? process.env.PROD_BASE_URL,
        ...payload,
      },
      null,
      2,
    ),
  );
}

function cleanupClient() {
  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL");
  const serviceRole = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient<Database>(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function deleteSavedFilterByName(name: string): Promise<void> {
  if (!name.startsWith("PROD-CANARY Filter Characterization ")) {
    throw new Error("Refusing to delete a non-canary saved filter.");
  }
  const client = cleanupClient();
  const { error } = await client
    .from("saved_filters")
    .delete()
    .eq("org_id", ORG_ID)
    .eq("name", name);
  if (error) throw error;
}

test("Pass 2 count matrix: rendered total matches the Pass 1 oracle", async ({
  page,
}) => {
  const rows = selectCountScenarios(loadMatrix());
  const results = await evaluateUiRows(page, rows);
  const failures = results.filter((row) => !row.pass);
  writeUiResults(`pass2-ui-count-matrix-${uiTargetLabel()}.json`, {
    kind: "count_matrix",
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    failures,
    results,
  });

  if (shouldAssertGreen()) {
    expect(failures).toEqual([]);
  }
});

test("Pass 2 URL rehydration: drawer renders each block kind from URL state", async ({
  page,
}) => {
  const rows = selectRehydrationScenarios(loadMatrix());
  const results = await evaluateUiRows(page, rows, { verifyDrawer: true });
  const failures = results.filter((row) => !row.pass);
  writeUiResults(`pass2-ui-rehydration-${uiTargetLabel()}.json`, {
    kind: "url_rehydration",
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    failures,
    results,
  });

  if (shouldAssertGreen()) {
    expect(failures).toEqual([]);
  }
});

test("Pass 2 saved preset: save, reload, and clean up through the test user", async ({
  page,
}) => {
  const row = loadMatrix().find(
    (candidate) =>
      candidate.filter === "cass" &&
      candidate.scenario.toLowerCase().includes("verified"),
  );
  expect(row).toBeTruthy();
  const presetName = `PROD-CANARY Filter Characterization ${Date.now()}`;

  await deleteSavedFilterByName(presetName);
  try {
    await page.goto(hrefForBlocks(row!.blocks), { waitUntil: "domcontentloaded" });
    expect(await renderedCount(page)).toBe(row!.expected);

    await page.getByRole("button", { name: /^Filters/i }).click();
    await checkSavePresetToggle(page);
    await page.getByPlaceholder("Preset name").fill(presetName);
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText(`Saved preset "${presetName}".`)).toBeVisible({
      timeout: 15_000,
    });

    await page.goto("/properties", { waitUntil: "domcontentloaded" });
    await renderedCount(page);
    await page.getByRole("button", { name: /^Filters/i }).click();
    await page.getByTestId("preset-dropdown-trigger").click();
    await page
      .locator("[data-preset-row]")
      .filter({ has: page.getByText(presetName, { exact: true }) })
      .getByText(presetName, { exact: true })
      .click();
    expect(await renderedCount(page)).toBe(row!.expected);

    await page.reload({ waitUntil: "domcontentloaded" });
    expect(await renderedCount(page)).toBe(row!.expected);

    writeUiResults(`pass2-ui-preset-${uiTargetLabel()}.json`, {
      kind: "saved_preset",
      total: 1,
      passed: 1,
      failed: 0,
      presetName,
      scenario: row!.scenario,
      expected: row!.expected,
    });
  } finally {
    await deleteSavedFilterByName(presetName);
  }
});
