import path from "node:path";

import { expect, test } from "@playwright/test";
import * as esbuild from "esbuild";

let harnessBundle = "";

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

test("Back returns to the template library and Forward reopens the editor after provider iframe navigation", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
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
      body:
        url.pathname === "/settings/esign-templates/template-1/edit"
          ? `<h1>Template editor</h1><a href="/settings/esign-templates">Template library</a><div id="editor-container"></div><script>${harnessBundle}<\/script>`
          : `<h1>Template library</h1><a href="/settings/esign-templates/template-1/edit">Edit template</a>`,
    });
  });

  await page.goto("https://sandra.test/settings/esign-templates");
  await page.getByRole("link", { name: "Edit template" }).click();
  await expect(
    page.getByRole("heading", { name: "Template editor" }),
  ).toBeVisible();
  const providerFrame = page.frameLocator(
    'iframe[title="Dropbox Sign template editor"]',
  );
  await expect(
    providerFrame.getByText("Provider editor is usable"),
  ).toBeVisible();
  const guardSequenceBeforeProviderNavigation =
    await waitForNavigationBoundary(page);
  const providerPage = page
    .frames()
    .find((frame) => new URL(frame.url()).hostname === "provider.test");
  expect(providerPage).toBeDefined();
  await providerPage?.evaluate(() => {
    localStorage.setItem("placed-field", "Seller signature placed");
    const placedField = document.querySelector("#placed-field");
    if (placedField) placedField.textContent = "Seller signature placed";
    history.pushState({ providerStep: 1 }, "", "/editor/fields");
    history.pushState({ providerStep: 2 }, "", "/editor/roles");
  });
  await expect
    .poll(() => providerPage?.url())
    .toBe("https://provider.test/editor/roles");
  await expect
    .poll(() => readNavigationBoundarySequence(page))
    .toBeGreaterThan(guardSequenceBeforeProviderNavigation);

  await page.evaluate(() => history.back());
  await expect(page).toHaveURL("https://sandra.test/settings/esign-templates");
  await expect(
    page.getByRole("heading", { name: "Template library" }),
  ).toBeVisible();

  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(
    "https://sandra.test/settings/esign-templates/template-1/edit",
  );
  await expect(
    page.getByRole("heading", { name: "Template editor" }),
  ).toBeVisible();
  await expect(
    providerFrame.getByText("Provider editor is usable"),
  ).toBeVisible();
  await expect(
    providerFrame.getByText("Seller signature placed"),
  ).toBeVisible();
  await waitForNavigationBoundary(page);

  await page.getByRole("link", { name: "Template library" }).click();
  await expect(page).toHaveURL("https://sandra.test/settings/esign-templates");
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(
    "https://sandra.test/settings/esign-templates/template-1/edit",
  );
  await expect(
    providerFrame.getByText("Provider editor is usable"),
  ).toBeVisible();
  await expect(
    providerFrame.getByText("Seller signature placed"),
  ).toBeVisible();
  await waitForNavigationBoundary(page);

  await page.evaluate(() => history.back());
  await expect(page).toHaveURL("https://sandra.test/settings/esign-templates");
  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(
    "https://sandra.test/settings/esign-templates/template-1/edit",
  );
  await expect(
    providerFrame.getByText("Provider editor is usable"),
  ).toBeVisible();
  await expect(
    providerFrame.getByText("Seller signature placed"),
  ).toBeVisible();
  await waitForNavigationBoundary(page);
  expect(pageErrors).toEqual([]);
});

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
    if (typeof history.state?.__sandraEsignEditorReturnEntry !== "string") {
      return 0;
    }
    const sequence = history.state?.__sandraEsignEditorGuardSequence;
    return typeof sequence === "number" ? sequence : 0;
  });
}
