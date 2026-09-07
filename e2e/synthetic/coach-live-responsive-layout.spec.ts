import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import * as esbuild from "esbuild";
import path from "node:path";
import postcss from "postcss";

let compiledCss = "";
let harnessBundle = "";

test.beforeAll(async () => {
  const cssResult = await postcss([tailwindcss()]).process(readFileSync(path.resolve(process.cwd(), "src/app/globals.css"), "utf8"), {
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
  { width: 1279, height: 900, label: "stacked-breakpoint" },
  { width: 1280, height: 900, label: "desktop-breakpoint" },
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
      expect(transcript!.width).toBe(380);
      expect(recommendations!.width).toBe(320);
      const topBar = await page.locator(".coach-top-bar").boundingBox();
      expect(topBar!.height).toBe(60);
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


test("keeps up-next and section navigation visible while a long script scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 650 });
  await mountFullCoach(page);
  await page.getByTestId("phase-rail-offer").click();
  const panel = page.getByTestId("coach-script-panel");
  const navigation = page.getByTestId("section-navigation");
  const hasOverflow = await panel.evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(hasOverflow).toBe(true);
  const preview = page.getByTestId("next-section-preview");
  await expect(preview).toBeInViewport({ ratio: 1 });
  const previewBefore = await preview.boundingBox();
  const before = await navigation.boundingBox();
  await expect(page.getByTestId("coach-next")).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("coach-back")).toBeInViewport({ ratio: 1 });
  await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const after = await navigation.boundingBox();
  const previewAfter = await preview.boundingBox();
  expect(Math.abs(previewAfter!.y - previewBefore!.y)).toBeLessThanOrEqual(1);
  await expect(preview).toBeInViewport({ ratio: 1 });
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("coach-next")).toBeInViewport({ ratio: 1 });
  await page.getByTestId("coach-next").click();
  await expect(page.getByTestId("current-section-title")).toHaveText("Choose the closing path");
  await page.getByTestId("coach-back").click();
  await expect(page.getByTestId("current-section-title")).toHaveText("Present the appropriate offer outcome");
});


test("keeps script text readable with the keypad in a short desktop panel", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await mountFullCoach(page);
  await page.getByTestId("phase-rail-offer").click();
  await page.getByTestId("coach-keypad-toggle").click();
  const panel = page.getByTestId("coach-script-panel");
  await panel.evaluate((element) => { element.scrollTop = 0; });
  const navigation = page.getByTestId("section-navigation");
  await expect(page.getByTestId("coach-next")).toBeInViewport({ ratio: 1 });
  const navBox = await navigation.boundingBox();
  const panelBox = await panel.boundingBox();
  expect(navBox!.y - panelBox!.y).toBeGreaterThanOrEqual(120);
  // Scroll a spoken line above the pinned navigation, then prove it is not
  // covered by the preview or dock. A bounding box alone misses occlusion.
  const line = page.getByTestId("current-section-script").locator("p").first();
  await line.evaluate((element) => element.scrollIntoView({ block: "start" }));
  const readable = await line.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + 10, box.top + 20);
    return hit !== null && element.contains(hit);
  });
  expect(readable).toBe(true);
  await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByTestId("next-section-preview-body")).toBeInViewport();
  await expect(page.getByTestId("coach-next")).toBeInViewport({ ratio: 1 });
});


test("keeps keyboard-focused script controls above the pinned preview", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 650 });
  await mountFullCoach(page);
  await page.getByTestId("phase-rail-offer").click();
  let checked = 0;
  for (let step = 0; step < 16; step++) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active?.closest('[data-testid="current-script-card"]')) return null;
      const rect = active.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { visible: hit !== null && active.contains(hit), id: active.dataset.testid };
    });
    if (state) {
      checked++;
      expect(state.visible, state.id).toBe(true);
    }
  }
  expect(checked).toBeGreaterThanOrEqual(4);
});
