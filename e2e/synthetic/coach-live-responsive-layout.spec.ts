import { expect, test, type Page } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import * as esbuild from "esbuild";
import path from "node:path";
import postcss from "postcss";

import { MAX_NUDGES, MAX_OBJECTION_CARDS } from "../../src/lib/coach/event-reducer";

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
    alias: { "@": path.resolve(process.cwd(), "src") },
    define: { "process.env.NODE_ENV": '"test"' },
    write: false,
    logLevel: "silent",
  });
  harnessBundle = bundleResult.outputFiles[0].text;
});

async function mountFullCoach(page: Page, withGuidance: boolean): Promise<void> {
  await page.setContent(`
    <style>${compiledCss}</style>
    <div id="root" data-guidance="${withGuidance}"></div>
  `);
  await page.addScriptTag({ content: harnessBundle });
  await expect(page.getByTestId("coach-live-view")).toBeVisible();
}

async function expectHorizontallyContained(page: Page, testId: string, viewportWidth: number): Promise<void> {
  const element = page.getByTestId(testId);
  await expect(element).toBeInViewport();
  const box = await element.boundingBox();
  expect(box, `${testId} must have browser geometry`).not.toBeNull();
  expect(box!.x, `${testId} left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${testId} right edge`).toBeLessThanOrEqual(viewportWidth);
}

for (const viewport of [
  { width: 375, height: 812, label: "mobile-tall" },
  { width: 375, height: 667, label: "mobile-short" },
  { width: 1440, height: 900, label: "desktop" },
]) {
  test(`hydrates the full live coach and keeps status, guidance, and controls usable at ${viewport.label} ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mountFullCoach(page, true);

    // This is the full real component, not an outer-shell approximation:
    // dialog, banners, top rail, transcript, focus stage, and dock all mount.
    await expect(page.getByRole("dialog", { name: "Live call coach" })).toBeVisible();
    await expect(page.getByTestId("coach-version-mismatch")).toBeVisible();
    await expect(page.getByTestId("coach-reconnect-gap")).toBeVisible();
    await expect(page.getByTestId("coach-transcript")).toHaveCount(1);
    // The transcript is the only viewport-conditional CSS in this component
    // (`hidden ... md:flex` on its <aside>) — asserting count alone (as this
    // test previously did) passes whether or not the compiled Tailwind
    // actually applied, since the node stays mounted either way. Assert
    // visibility too so a broken `md:` breakpoint or a missing compiled
    // class would fail this test.
    if (viewport.width >= 768) {
      await expect(page.getByTestId("coach-transcript")).toBeVisible();
    } else {
      await expect(page.getByTestId("coach-transcript")).toBeHidden();
    }
    await expect(page.getByTestId("coach-focus-stage")).toBeVisible();
    await expect(page.getByTestId("coach-call-dock-row")).toBeVisible();

    // Offer phase and critical call state are pinned independently of the
    // horizontally scrollable phase rail, including at its initial position.
    await expect(page.getByTestId("coach-current-phase")).toHaveText("Phase · Offer");
    await expectHorizontallyContained(page, "coach-current-phase", viewport.width);
    await expectHorizontallyContained(page, "coach-call-timer", viewport.width);
    await expectHorizontallyContained(page, "coach-live-pill", viewport.width);
    await expectHorizontallyContained(page, "hold-timer", viewport.width);

    await page.getByTestId("phase-rail-reveal").click();
    await expect(page.getByTestId("coach-current-phase")).toHaveText("Phase · Offer");
    await expect(page.getByTestId("coach-viewing-phase")).toHaveText("Viewing · Reveal");
    await expectHorizontallyContained(page, "coach-viewing-phase", viewport.width);

    // The gate warning uses the same pinned strip and must remain visible
    // when the real screen advances to the phase that owns it.
    await page.evaluate(() => window.coachHarness.setPhase("secure_positioning"));
    await expect(page.getByTestId("coach-current-phase")).toHaveText("Phase · Secure Positioning");
    await expectHorizontallyContained(page, "gate-no_concerns", viewport.width);

    expect(await page.getByTestId("objection-card").count()).toBe(MAX_OBJECTION_CARDS);
    expect(await page.getByTestId("coach-nudge").count()).toBe(MAX_NUDGES);
    await expect(page.locator('[data-testid="objection-card"][data-active="true"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="coach-nudge"][data-active="true"]')).toHaveCount(0);

    await page.getByTestId("coach-keypad-toggle").click();
    const stack = await page.getByTestId("coach-guidance-stack").boundingBox();
    const focusStage = await page.getByTestId("coach-focus-stage").boundingBox();
    const dockRow = await page.getByTestId("coach-call-dock-row").boundingBox();
    const keypad = await page.getByTestId("phone-keypad").boundingBox();
    expect(stack).not.toBeNull();
    expect(focusStage).not.toBeNull();
    expect(dockRow).not.toBeNull();
    expect(keypad).not.toBeNull();
    expect(stack!.y).toBeGreaterThanOrEqual(focusStage!.y);
    expect(stack!.y + stack!.height).toBeLessThanOrEqual(keypad!.y);
    expect(stack!.y + stack!.height).toBeLessThanOrEqual(dockRow!.y);

    for (const testId of ["coach-mute", "coach-keypad-toggle", "coach-hold", "coach-hangup"]) {
      await expectHorizontallyContained(page, testId, viewport.width);
    }

    await page.locator('[data-testid="objection-card"][data-active="true"]').click();
    await page.getByTestId("coach-mute").click();
    await page.getByTestId("coach-hold").click();
    await page.getByTestId("coach-hangup").click();
    await page.getByRole("button", { name: "Keypad 1" }).click();
    await page.getByRole("button", { name: "Keypad #" }).click();
  });
}

test("keeps offer-entry digits out of DTMF while the keypad is genuinely open and the editor is genuinely mounted, in hydrated Chromium", async ({ page }) => {
  // Regression for a false-pass a merge-gate review caught: the previous
  // version of this test opened the keypad, then opened the entry editor
  // — but EntryTokenChip's onBeginEdit always closes the keypad the
  // instant editing starts, so keypadOpen was false for the rest of the
  // test. The digit listener bails on `!keypadOpen` before it ever reaches
  // the mounted-editor guard (`document.querySelector
  // ("[data-coach-entry-editor]")`) in coach-live-view.tsx — so the old
  // test passed even with that guard deleted entirely (confirmed while
  // writing this fix, in this exact hydrated-Chromium harness).
  //
  // This version reopens the keypad via `.dispatchEvent("click")` instead
  // of Playwright's `.click()`. `.click()` performs a real pointer click,
  // which — in Chromium — focuses the button and blurs the still-editing
  // input, committing and closing the editor via its onBlur handler.
  // `dispatchEvent` fires only the click event without moving focus, so
  // the editor stays mounted while the keypad reopens. This isn't a test
  // artifact: real-world cross-browser click-focus behavior varies (e.g.
  // Safari/Firefox on macOS don't always focus a clicked button), so a rep
  // can genuinely end up with the keypad open and an editor still
  // mounted. The digit keydown is then dispatched on the dialog rather
  // than typed into the (still-focused) input, so `event.target` is
  // outside any editable field — isolating the mounted-editor guard from
  // both the keypad-closed guard and the target-is-input guard.
  await page.setViewportSize({ width: 375, height: 812 });
  await mountFullCoach(page, false);
  await page.getByTestId("coach-keypad-toggle").click();
  await page.getByTestId("entry-chip-offer_price").first().click();
  await expect(page.getByTestId("coach-keypad-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("entry-input-offer_price").fill("210");

  await page.getByTestId("coach-keypad-toggle").dispatchEvent("click");
  await expect(page.getByTestId("coach-keypad-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("entry-input-offer_price")).toBeVisible();

  const dialog = page.getByRole("dialog", { name: "Live call coach" });
  await dialog.dispatchEvent("keydown", { key: "5" });

  expect(await page.evaluate(() => window.coachHarness.digits)).toEqual([]);
  // The guard didn't merely no-op the keypress — the value typed before
  // reopening the keypad is still intact.
  await expect(page.getByTestId("entry-input-offer_price")).toHaveValue("210");
});

test("does not turn a phase-replaced offer edit into keyboard DTMF in hydrated Chromium", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mountFullCoach(page, false);
  await page.getByTestId("coach-keypad-toggle").click();
  await page.getByTestId("entry-chip-offer_price").first().click();
  await expect(page.getByTestId("coach-keypad-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("entry-input-offer_price").fill("210");

  await page.evaluate(() => window.coachHarness.setPhase("reveal"));
  await expect(page.getByTestId("entry-input-offer_price")).toHaveCount(0);
  await page.getByRole("dialog", { name: "Live call coach" }).focus();
  await page.keyboard.press("5");

  expect(await page.evaluate(() => window.coachHarness.digits)).toEqual([]);
});

test("keeps intentional keyboard DTMF working with guidance when no editor is active", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mountFullCoach(page, true);
  await page.getByTestId("coach-keypad-toggle").click();
  await page.getByRole("dialog", { name: "Live call coach" }).focus();
  await page.keyboard.press("5");

  expect(await page.evaluate(() => window.coachHarness.digits)).toEqual(["5"]);
});
