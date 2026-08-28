import { expect, test, type Page } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import * as esbuild from "esbuild";
import path from "node:path";
import postcss from "postcss";

let compiledCss = "";
let harnessBundle = "";

test.beforeAll(async () => {
  const cssResult = await postcss([tailwindcss()]).process('@import "tailwindcss";', {
    from: path.resolve(process.cwd(), "src/app/globals.css"),
  });
  compiledCss = cssResult.css;
  const bundleResult = esbuild.buildSync({
    entryPoints: [path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-live-responsive-harness.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    jsx: "automatic",
    jsxImportSource: "react",
    alias: {
      "@/lib/coach/recommendation-action": path.resolve(
        process.cwd(),
        "e2e/synthetic/fixtures/coach-recommendation-action-stub.ts",
      ),
      "@": path.resolve(process.cwd(), "src"),
    },
    define: { "process.env.NODE_ENV": '"test"' },
    write: false,
    logLevel: "silent",
  });
  harnessBundle = bundleResult.outputFiles[0].text;
});

async function mountFullCoach(page: Page): Promise<void> {
  await page.setContent(`<style>${compiledCss}</style><div id="root"></div>`);
  await page.addScriptTag({ content: harnessBundle });
  const coach = page.getByTestId("coach-live-view");
  await expect(coach).toBeVisible();
  await coach.evaluate(async (element) => {
    await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
  });
}

async function expectHorizontallyContained(page: Page, testId: string, viewportWidth: number): Promise<void> {
  const element = page.getByTestId(testId);
  await expect(element).toBeInViewport();
  const box = await element.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth);
}

for (const viewport of [
  { width: 375, height: 812, label: "mobile-tall" },
  { width: 375, height: 667, label: "mobile-short" },
  { width: 1440, height: 900, label: "desktop" },
]) {
  test(`keeps transcript, manual script, recommendations, and call controls usable at ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mountFullCoach(page);

    await expect(page.getByRole("dialog", { name: "Live call coach" })).toBeVisible();
    await expect(page.getByTestId("coach-reconnect-gap")).toBeVisible();
    await expect(page.getByTestId("coach-transcript")).toBeVisible();
    await expect(page.getByTestId("current-script-card")).toBeVisible();
    await expect(page.getByTestId("current-section-title")).toHaveText("Open the call");
    await expect(page.getByTestId("next-section-preview")).toContainText("Set the qualification frame");
    await expect(page.getByTestId("coach-recommendations")).toBeVisible();
    await expect(page.getByTestId("coach-call-dock-row")).toBeVisible();

    const transcript = await page.getByLabel("Live transcript").boundingBox();
    const script = await page.getByTestId("coach-script-panel").boundingBox();
    const recommendations = await page.getByTestId("coach-recommendations").boundingBox();
    expect(transcript).not.toBeNull();
    expect(script).not.toBeNull();
    expect(recommendations).not.toBeNull();
    if (viewport.width >= 1280) {
      expect(transcript!.x + transcript!.width).toBeLessThanOrEqual(script!.x + 1);
      expect(script!.x + script!.width).toBeLessThanOrEqual(recommendations!.x + 1);
    } else {
      expect(transcript!.y + transcript!.height).toBeLessThanOrEqual(script!.y + 1);
      expect(script!.y + script!.height).toBeLessThanOrEqual(recommendations!.y + 1);
    }

    await page.getByTestId("phase-rail-reveal").click();
    await expect(page.getByTestId("current-section-title")).toHaveText("Open the seller situation");
    await expect(page.getByTestId("coach-current-phase")).toHaveText("Phase · Reveal");

    await page.evaluate(() => window.coachHarness.emitLegacyPhase("close"));
    await expect(page.getByTestId("current-section-title")).toHaveText("Open the seller situation");
    await expect(page.getByTestId("coach-current-phase")).toHaveText("Phase · Reveal");

    await page.getByTestId("coach-next").click();
    await expect(page.getByTestId("current-section-title")).toHaveText("Explore the seller’s situation");
    await page.getByTestId("coach-back").click();
    await expect(page.getByTestId("current-section-title")).toHaveText("Open the seller situation");

    for (const testId of ["coach-mute", "coach-keypad-toggle", "coach-hold", "coach-hangup"]) {
      await expectHorizontallyContained(page, testId, viewport.width);
    }

    await page.getByTestId("coach-keypad-toggle").click();
    await page.getByRole("button", { name: "Keypad 1" }).click();
    await page.getByRole("button", { name: "Keypad #" }).click();
    expect(await page.evaluate(() => window.coachHarness.digits)).toEqual(["1", "#"]);
  });
}

test("keeps offer-entry digits out of DTMF while the keypad and editor are both mounted", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mountFullCoach(page);
  await page.evaluate(() => window.coachHarness.setPhase("offer"));
  await page.getByTestId("coach-keypad-toggle").click();
  await page.getByTestId("entry-chip-offer_price").first().click();
  await page.getByTestId("entry-input-offer_price").fill("210");

  await page.getByTestId("coach-keypad-toggle").dispatchEvent("click");
  await expect(page.getByTestId("coach-keypad-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("entry-input-offer_price")).toBeVisible();
  await page.getByRole("dialog", { name: "Live call coach" }).dispatchEvent("keydown", { key: "5" });

  expect(await page.evaluate(() => window.coachHarness.digits)).toEqual([]);
  await expect(page.getByTestId("entry-input-offer_price")).toHaveValue("210");
});

test("does not turn a section replacement into keyboard DTMF", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mountFullCoach(page);
  await page.evaluate(() => window.coachHarness.setPhase("offer"));
  await page.getByTestId("coach-keypad-toggle").click();
  await page.getByTestId("entry-chip-offer_price").first().click();
  await page.getByTestId("entry-input-offer_price").fill("210");

  await page.evaluate(() => window.coachHarness.setPhase("reveal"));
  await expect(page.getByTestId("entry-input-offer_price")).toHaveCount(0);
  await page.getByRole("dialog", { name: "Live call coach" }).focus();
  await page.keyboard.press("5");

  expect(await page.evaluate(() => window.coachHarness.digits)).toEqual([]);
});

test("keeps intentional keyboard DTMF working when no editor is active", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mountFullCoach(page);
  await page.getByTestId("coach-keypad-toggle").click();
  await page.getByRole("dialog", { name: "Live call coach" }).focus();
  await page.keyboard.press("5");
  expect(await page.evaluate(() => window.coachHarness.digits)).toEqual(["5"]);
});
