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
    external: ["crypto"],
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
    define: {
      "process.env.NODE_ENV": '"test"',
      "process.env.NEXT_PUBLIC_COACH_SCRIPT_V2": '""',
      "process.env.NEXT_PUBLIC_COACH_WIRE_DIGEST_STRICT": '""',
    },
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
  { width: 320, height: 640, label: "mobile-narrow" },
  { width: 375, height: 812, label: "mobile-tall" },
  { width: 375, height: 667, label: "mobile-short" },
  { width: 1279, height: 900, label: "stacked-breakpoint" },
  { width: 1280, height: 900, label: "desktop-breakpoint" },
  { width: 1440, height: 900, label: "desktop" },
]) {
  test(`keeps transcript, manual script, card tray, and call controls usable at ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mountFullCoach(page);

    await expect(page.getByRole("dialog", { name: "Live call coach" })).toBeVisible();
    await expect(page.getByTestId("coach-reconnect-gap")).toBeVisible();
    await expect(page.getByTestId("coach-transcript")).toBeVisible();
    await expect(page.getByTestId("current-script-card")).toBeVisible();
    await expect(page.getByTestId("current-section-title")).toHaveText("Open the call");
    await expect(page.getByTestId("next-section-preview")).toContainText("Set the qualification frame");
    await expect(page.getByTestId("coach-recommendations")).toHaveCount(0);
    await expect(page.getByTestId("coach-card-tray")).toBeVisible();
    await expect(page.getByTestId("coach-script-scroll")).toHaveCSS("overflow-y", "auto");
    await expect(page.getByTestId("coach-objection-prompt-label")).toHaveText("Price concern");
    await expect(page.getByTestId("coach-call-dock-row")).toBeVisible();

    const transcript = await page.getByLabel("Live transcript").boundingBox();
    const script = await page.getByTestId("coach-script-panel").boundingBox();
    const tray = await page.getByTestId("coach-card-tray").boundingBox();
    const navigation = await page.getByTestId("section-navigation").boundingBox();
    expect(transcript).not.toBeNull();
    expect(script).not.toBeNull();
    expect(tray).not.toBeNull();
    expect(navigation).not.toBeNull();
    if (viewport.width >= 1280) {
      expect(transcript!.width).toBe(380);
      const topBar = await page.locator(".coach-top-bar").boundingBox();
      expect(topBar!.height).toBe(60);
      expect(transcript!.x + transcript!.width).toBeLessThanOrEqual(script!.x + 1);
      expect(script!.x + script!.width).toBeLessThanOrEqual(viewport.width + 1);
    } else {
      expect(transcript!.y + transcript!.height).toBeLessThanOrEqual(script!.y + 1);
      expect(tray!.y + tray!.height).toBeLessThanOrEqual(navigation!.y + 1);
    }

    // Pinned navigation: the script box is the only scroller, the tray sits
    // directly above Back/Next, and the Back/Next row ends the script column
    // at every breakpoint, uncovered by the call dock.
    const scrollBox = await page.getByTestId("coach-script-scroll").boundingBox();
    expect(scrollBox!.y + scrollBox!.height).toBeLessThanOrEqual(tray!.y + 1);
    expect(navigation!.y + navigation!.height).toBeLessThanOrEqual(script!.y + script!.height + 1);
    expect(navigation!.y - (tray!.y + tray!.height)).toBeLessThanOrEqual(1);
    for (const testId of ["coach-back", "coach-next"]) {
      const control = page.getByTestId(testId);
      await control.scrollIntoViewIfNeeded();
      // A disabled Back button ignores pointer events, so hit-test the row's
      // whole width through the section label as well as the Next button.
      const uncovered = await control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const target = element.matches(":disabled")
          ? element.closest('[data-testid="section-navigation"]')!.querySelector("span")!
          : element;
        const point = target.getBoundingClientRect();
        const hit = document.elementFromPoint(point.left + point.width / 2, point.top + point.height / 2);
        return box.width > 0 && hit !== null && target.contains(hit);
      });
      expect(uncovered, testId).toBe(true);
      await expectHorizontallyContained(page, testId, viewport.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (viewport.width >= 1280) {
      await expect(page.getByTestId("coach-next")).toBeInViewport({ ratio: 1 });
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
  const panel = page.getByTestId("coach-script-scroll");
  const column = page.getByTestId("coach-script-panel");
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
  const panel = page.getByTestId("coach-script-scroll");
  const column = page.getByTestId("coach-script-panel");
  await panel.evaluate((element) => { element.scrollTop = 0; });
  const navigation = page.getByTestId("section-navigation");
  await expect(page.getByTestId("coach-next")).toBeInViewport({ ratio: 1 });
  const navBox = await navigation.boundingBox();
  const panelBox = await column.boundingBox();
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


// The objection card will carry several long paragraphs of reply text. Fill its
// existing reply slot (a <ul class="coach-prompt-replies"> of <li>) with clearly
// fake filler and prove the tray scrolls inside itself instead of pushing
// Back/Next away or crushing the script box.
for (const viewport of [
  { width: 320, height: 640, label: "mobile-narrow" },
  { width: 375, height: 667, label: "mobile-short" },
  { width: 1279, height: 900, label: "stacked-breakpoint" },
  { width: 1280, height: 650, label: "desktop-short" },
  { width: 1440, height: 900, label: "desktop" },
]) {
  test(`keeps pinned navigation with long card content at ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mountFullCoach(page);
    await page.getByTestId("coach-objection-prompt").evaluate((card) => {
      const list = document.createElement("ul");
      list.className = "coach-prompt-replies";
      list.setAttribute("data-testid", "synthetic-long-replies");
      for (let index = 0; index < 4; index++) {
        const item = document.createElement("li");
        item.textContent = `PLACEHOLDER FILLER ${index} `.repeat(45);
        list.append(item);
      }
      card.append(list);
    });
    const tray = page.getByTestId("coach-card-tray");
    expect(await tray.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const scrollBox = await page.getByTestId("coach-script-scroll").boundingBox();
    const trayBox = await tray.boundingBox();
    const navigation = page.getByTestId("section-navigation");
    const navBox = await navigation.boundingBox();
    const column = await page.getByTestId("coach-script-panel").boundingBox();
    expect(scrollBox!.height).toBeGreaterThanOrEqual(viewport.width >= 1280 ? 90 : 220);
    expect(trayBox!.height).toBeLessThanOrEqual(viewport.height * 0.4 + 1);
    expect(trayBox!.y + trayBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
    expect(navBox!.y + navBox!.height).toBeLessThanOrEqual(column!.y + column!.height + 1);
    if (viewport.width >= 1280) {
      await expect(page.getByTestId("coach-next")).toBeInViewport({ ratio: 1 });
      await expect(page.getByTestId("coach-back")).toBeInViewport({ ratio: 1 });
    } else {
      await page.getByTestId("coach-next").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("coach-next")).toBeInViewport({ ratio: 1 });
    }
    // Scrolling the tray does not move Back/Next.
    const before = await navigation.boundingBox();
    await tray.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const after = await navigation.boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  });
}

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
