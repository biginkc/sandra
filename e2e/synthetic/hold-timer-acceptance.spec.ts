import { expect, test } from "@playwright/test";
import * as esbuild from "esbuild";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

let compiledCss = "";
let harnessBundle = "";

test.beforeAll(async () => {
  const cssResult = await postcss([tailwindcss()]).process('@import "tailwindcss";', {
    from: path.resolve(process.cwd(), "src/app/globals.css"),
  });
  compiledCss = cssResult.css;
  const bundleResult = await esbuild.build({
    entryPoints: [path.resolve(process.cwd(), "e2e/synthetic/fixtures/hold-timer-browser-harness.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    jsx: "automatic",
    jsxImportSource: "react",
    alias: { "@": path.resolve(process.cwd(), "src") },
    define: { "process.env.NODE_ENV": '"test"' },
    write: false,
    logLevel: "silent",
  });
  harnessBundle = bundleResult.outputFiles[0].text;
});

async function mount(page: import("@playwright/test").Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`<style>${compiledCss}</style><div id="root"></div>`);
  await page.addScriptTag({ content: harnessBundle });
  await expect(page.getByTestId("coach-script")).toBeVisible();
}

async function emit(page: import("@playwright/test").Page, name: string): Promise<void> {
  await page.evaluate((stimulus) => window.holdTimerHarness[stimulus](), name);
}

test("shows a truthful hold countdown while preserving the script across collapse and expiry", async ({ page }) => {
  await mount(page);

  await emit(page, "startHold");
  await expect(page.getByTestId("hold-timer")).toHaveText("Hold 03:00");
  await expect(page.getByTestId("coach-script")).toBeVisible();

  await expect.poll(async () => page.getByTestId("hold-timer").getAttribute("data-remaining-seconds"), { timeout: 3_000 }).toBe("179");
  await expect(page.getByTestId("hold-timer")).toContainText("02:59");

  await emit(page, "collapse");
  await expect(page.getByTestId("coach-collapsed")).toBeVisible();
  await emit(page, "reopen");
  await expect(page.getByTestId("hold-timer")).toBeVisible();
  await expect(page.getByTestId("hold-timer")).not.toHaveText("Hold 03:00");
  await expect(page.getByTestId("coach-script")).toBeVisible();

  await emit(page, "expireHold");
  await expect(page.getByTestId("hold-timer")).toHaveText("Hold 00:00");
  await expect(page.getByTestId("coach-script")).toBeVisible();

  await emit(page, "resume");
  await expect(page.getByTestId("hold-timer")).toHaveCount(0);
  await expect(page.getByTestId("coach-script")).toBeVisible();

  await emit(page, "holdAgain");
  await expect(page.getByTestId("hold-timer")).toHaveText("Hold 03:00");

  await emit(page, "clearTimer");
  await expect(page.getByTestId("hold-timer")).toHaveCount(0);
  await expect(page.getByTestId("coach-script")).toBeVisible();
});
