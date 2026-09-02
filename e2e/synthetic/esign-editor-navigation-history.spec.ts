import path from "node:path";

import { expect, test } from "@playwright/test";
import * as esbuild from "esbuild";

let harnessBundle = "";
const pageErrors = new WeakMap<import("@playwright/test").Page, Error[]>();

test.beforeAll(() => {
  const result = esbuild.buildSync({
    entryPoints: [
      path.resolve(
        process.cwd(),
        "e2e/synthetic/fixtures/esign-editor-navigation-history-harness.ts",
      ),
    ],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    alias: { "@": path.resolve(process.cwd(), "src") },
    write: false,
    logLevel: "silent",
  });
  harnessBundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  const errors: Error[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "provider.test") {
      await route.fulfill({
        contentType: "text/html",
        body: `<p>Provider editor is usable</p><p id="placed-field"></p><script>
          document.querySelector("#placed-field").textContent = localStorage.getItem("placed-field") ?? "No field placed";
        <\/script>`,
      });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<main id="app"></main><script>${harnessBundle}<\/script>`,
    });
  });
  await page.goto("https://sandra.test/settings/esign-templates");
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

test("Forward reuses the take-once session for an unfinished initial draft", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Create unfinished draft" }).click();
  await expectEditorReady(page);
  const guardBeforeProviderNavigation = await waitForNavigationBoundary(page);
  const providerPage = page
    .frames()
    .find((frame) => new URL(frame.url()).hostname === "provider.test");
  expect(providerPage).toBeDefined();
  await providerPage?.evaluate(() => {
    localStorage.setItem("placed-field", "Seller signature placed");
    document.querySelector("#placed-field")!.textContent =
      "Seller signature placed";
    history.pushState({ providerStep: 1 }, "", `${location.pathname}/fields`);
    history.pushState({ providerStep: 2 }, "", `${location.pathname}/roles`);
  });
  await expect
    .poll(() => readNavigationBoundarySequence(page))
    .toBeGreaterThan(guardBeforeProviderNavigation);

  await page.evaluate(() => history.back());
  await expectLibrary(page);
  await page.evaluate(() => history.forward());

  await expectEditorReady(page);
  await expect(
    page
      .frameLocator('iframe[title="Dropbox Sign template editor"]')
      .getByText("Seller signature placed"),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & {
            __startEditorAttempts?: Record<string, number>;
          }).__startEditorAttempts?.["template-1"] ?? 0,
      ),
    )
    .toBe(0);
});

test("Back restoration preserves the legitimate Forward destination", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Edit finalized template" }).click();
  await expectEditorReady(page);
  await waitForNavigationBoundary(page);
  await page.getByRole("link", { name: "Another route" }).click();
  await expect(
    page.getByRole("heading", { name: "Another route" }),
  ).toBeVisible();

  await page.evaluate(() => history.back());
  await expectEditorReady(page);
  await page.evaluate(() => history.forward());

  await expect(page).toHaveURL("https://sandra.test/another-route");
  await expect(
    page.getByRole("heading", { name: "Another route" }),
  ).toBeVisible();
});

test("Back from a restarted replacement returns to the library", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Create unfinished draft" }).click();
  await expectEditorReady(page);
  await waitForNavigationBoundary(page);
  await page.getByRole("button", { name: "Restart placement" }).click();
  await expect(page).toHaveURL(
    "https://sandra.test/settings/esign-templates/replacement-1/edit",
  );
  await expectEditorReady(page);
  await waitForNavigationBoundary(page);

  await page.evaluate(() => history.back());
  await expectLibrary(page);
});

async function expectEditorReady(page: import("@playwright/test").Page) {
  await expect(
    page.getByRole("heading", { name: "Template editor" }),
  ).toBeVisible();
  await expect(
    page
      .frameLocator('iframe[title="Dropbox Sign template editor"]')
      .getByText("Provider editor is usable"),
  ).toBeVisible();
}

async function expectLibrary(page: import("@playwright/test").Page) {
  await expect(page).toHaveURL("https://sandra.test/settings/esign-templates");
  await expect(
    page.getByRole("heading", { name: "Template library" }),
  ).toBeVisible();
}

async function waitForNavigationBoundary(
  page: import("@playwright/test").Page,
): Promise<number> {
  await expect
    .poll(() => readNavigationBoundarySequence(page))
    .toBeGreaterThan(0);
  return readNavigationBoundarySequence(page);
}

async function readNavigationBoundarySequence(
  page: import("@playwright/test").Page,
): Promise<number> {
  return page.evaluate(() => {
    const sequence = history.state?.__sandraEsignEditorGuardSequence;
    return typeof sequence === "number" ? sequence : 0;
  });
}
