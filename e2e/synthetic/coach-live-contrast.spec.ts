import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import * as esbuild from "esbuild";
import postcss from "postcss";
import sharp from "sharp";

// Regression coverage for WCAG AA contrast failures found across two rounds
// of the PR #414 merge-gate review: the focus-mode redesign introduced
// emerald/amber foreground text and a dimmed "coming next" preview that read
// fine against bare Tailwind swatches, but fell below 4.5:1 once measured
// against Sandra's real composited theme — either because the background is
// a custom token (--card, the amber-400/15 tint) or because an ancestor
// `opacity` was scaling every descendant's effective alpha.
//
// A prior version of this file got both of those wrong:
//   1. It compiled only the literal string `@import "tailwindcss";`, not
//      globals.css's actual contents, so the Sandra tokens, `.bg-card`, and
//      the `.dark` variant never made it into the generated CSS — light and
//      "dark" produced identical, wrong colors.
//   2. It rasterized bare color values (`getComputedStyle().color` /
//      `.backgroundColor`) through a canvas swatch, which can never see an
//      ancestor's `opacity` — that's exactly the CSS property behind the
//      "coming next" preview's contrast failure.
//
// This version fixes both: it compiles the REAL globals.css file (so
// `@import "./sandra-tokens.css"` and the local `.dark { ... }` block
// actually resolve), and it measures each element's contrast from ACTUAL
// RENDERED PIXELS — a real Playwright element screenshot, decoded with
// `sharp` — rather than from computed-style color values. Sampling real
// pixels means ancestor opacity, translucent tints, and stacking are
// captured automatically, the same way a human eyeballing the browser would
// see them, with no separate model of "what CSS properties matter" to keep
// in sync with the component.
let compiledCss = "";
let harnessBundle = "";

test.beforeAll(async () => {
  const globalsPath = path.resolve(process.cwd(), "src/app/globals.css");
  const globalsSource = await readFile(globalsPath, "utf8");
  const cssResult = await postcss([tailwindcss()]).process(globalsSource, { from: globalsPath });
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

async function mountFullCoach(
  page: Page,
  opts: { darkMode: boolean; withGuidance: boolean; held?: boolean },
): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`
    <style>${compiledCss}</style>
    <div id="root" data-guidance="${opts.withGuidance}" data-held="${opts.held ?? false}"></div>
  `);
  // Real app puts `.dark` on <html>, so the whole document — not just a
  // wrapper div — resolves the dark theme tokens, matching production.
  await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), opts.darkMode);
  await page.addScriptTag({ content: harnessBundle });
  await expect(page.getByTestId("coach-live-view")).toBeVisible();
}

function srgbToLin(c: number): number {
  const n = c / 255;
  return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}
function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

type PixelMeasurement = { ratio: number; fg: [number, number, number]; bg: [number, number, number] };

/**
 * Measures the real, on-screen contrast between an element's text and its
 * composited background by screenshotting the element TWICE: once as
 * normally rendered, and once with the element's own `color` forced to
 * `transparent` (an inline style always wins over a class, so this reliably
 * hides only the text, leaving every ancestor's opacity/tint/background
 * exactly as painted).
 *
 * The two screenshots are then differenced PER COORDINATE. A pixel that is
 * identical in both passes cannot be text — only text disappears when
 * `color` goes transparent — so every unchanged coordinate is discarded,
 * and each surviving coordinate is compared against ITS OWN background
 * pixel from the second screenshot rather than against one sampled point.
 *
 * That per-coordinate rule is the whole correctness argument, and an
 * earlier version of this file got it wrong in a way that silently
 * defeated the entire test. It compared every candidate pixel against a
 * SINGLE center background pixel, which let anything merely different from
 * that one point pose as text: the Live badge's emerald border outranked
 * the badge's own glyphs, so the probe reported the border's contrast and
 * passed at 13.67:1 while the actual text sat at 3.26:1. Differencing the
 * two passes excludes borders, tints and decorations by construction,
 * because none of them change when the text is hidden.
 *
 * Among the surviving text pixels, the solid glyph fill is the most
 * frequent quantized color — anti-aliased edge blends are numerous but
 * spread thinly across many buckets, while the true ink color repeats
 * exactly. Rare stray glyphs (the phase rail's trailing "✓" renders a
 * handful of near-white pixels outside the normal text pipeline) are
 * outvoted rather than allowed to dominate, which a "most extreme pixel"
 * search could not do.
 */
async function measureRenderedContrast(locator: Locator): Promise<PixelMeasurement> {
  // Decorative `aria-hidden` descendants are not text and are exempt from
  // the 4.5:1 text-contrast rule (they fall under non-text contrast, and a
  // purely decorative graphic is exempt outright). Hide them before
  // sampling: the Live badge's `bg-emerald-500` dot pulses, so its pixels
  // differ between the two passes and would otherwise survive the
  // difference test and be counted as text. `visibility: hidden` (not
  // `display: none`) so layout — and therefore glyph position — is
  // identical across both passes; `animations: "disabled"` on the
  // screenshots keeps any remaining motion from making readings drift.
  await locator.evaluate((el) => {
    el.querySelectorAll<HTMLElement>('[aria-hidden="true"]').forEach((node, index) => {
      node.dataset.contrastProbeOrigVisibility = node.style.visibility;
      node.dataset.contrastProbeHidden = String(index);
      node.style.visibility = "hidden";
    });
  });

  const withText = await locator.screenshot({ animations: "disabled" });

  await locator.evaluate((el) => {
    const node = el as HTMLElement;
    node.dataset.contrastProbeOrigColor = node.style.color;
    node.style.color = "transparent";
  });
  const bgOnly = await locator.screenshot({ animations: "disabled" });
  await locator.evaluate((el) => {
    const node = el as HTMLElement;
    node.style.color = node.dataset.contrastProbeOrigColor ?? "";
    delete node.dataset.contrastProbeOrigColor;
    el.querySelectorAll<HTMLElement>("[data-contrast-probe-hidden]").forEach((hidden) => {
      hidden.style.visibility = hidden.dataset.contrastProbeOrigVisibility ?? "";
      delete hidden.dataset.contrastProbeOrigVisibility;
      delete hidden.dataset.contrastProbeHidden;
    });
  });

  const [fgImg, bgImg] = await Promise.all([
    sharp(withText).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(bgOnly).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (fgImg.info.width !== bgImg.info.width || fgImg.info.height !== bgImg.info.height) {
    throw new Error("contrast probe screenshots changed size between passes — element must have resized");
  }
  const { width, height, channels } = bgImg.info;
  // Difference the two passes per coordinate. Only text changes when the
  // element's own `color` is forced transparent, so an unchanged pixel is
  // by definition not text: borders, translucent tints, decorative fills
  // and corner-clip leakage all cancel out here, with no geometric
  // guesswork about where the glyphs might be.
  const CHANGE_THRESHOLD = 8; // per-channel noise floor for the rasteriser
  const textPixels: { fr: number; fg_: number; fb: number; br: number; bg_: number; bb: number }[] = [];
  for (let i = 0; i < width * height; i++) {
    const idx = i * channels;
    const fr = fgImg.data[idx];
    const fg_ = fgImg.data[idx + 1];
    const fb = fgImg.data[idx + 2];
    const br = bgImg.data[idx];
    const bg_ = bgImg.data[idx + 1];
    const bb = bgImg.data[idx + 2];
    const changed =
      Math.abs(fr - br) > CHANGE_THRESHOLD ||
      Math.abs(fg_ - bg_) > CHANGE_THRESHOLD ||
      Math.abs(fb - bb) > CHANGE_THRESHOLD;
    if (!changed) continue;
    textPixels.push({ fr, fg_, fb, br, bg_, bb });
  }

  if (textPixels.length === 0) {
    throw new Error("contrast probe found no text pixels — the element rendered no visible text to measure");
  }

  // The solid glyph fill is the most frequent quantised colour among the
  // text pixels. Anti-aliased edge blends are plentiful but scatter across
  // many buckets; the true ink colour repeats exactly, so it wins on count.
  const buckets = new Map<string, { count: number; fr: number; fg_: number; fb: number; br: number; bg_: number; bb: number }>();
  const quant = 8;
  for (const px of textPixels) {
    const key = `${Math.round(px.fr / quant)},${Math.round(px.fg_ / quant)},${Math.round(px.fb / quant)}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      existing.fr += px.fr;
      existing.fg_ += px.fg_;
      existing.fb += px.fb;
      existing.br += px.br;
      existing.bg_ += px.bg_;
      existing.bb += px.bb;
    } else {
      buckets.set(key, { count: 1, ...px });
    }
  }
  const best = [...buckets.values()].sort((a, b2) => b2.count - a.count)[0];
  const fg: [number, number, number] = [
    Math.round(best.fr / best.count),
    Math.round(best.fg_ / best.count),
    Math.round(best.fb / best.count),
  ];
  // Background taken from the SAME coordinates the winning glyph pixels
  // occupy, so a gradient or tint behind the text is measured where the
  // text actually sits rather than wherever a single probe point landed.
  const bg: [number, number, number] = [
    Math.round(best.br / best.count),
    Math.round(best.bg_ / best.count),
    Math.round(best.bb / best.count),
  ];

  return { ratio: contrastRatio(fg, bg), fg, bg };
}

// Sample at 3x device pixel ratio. At 1x, 10px UI text (the Live badge, the
// "coming next" label) has no fully-opaque glyph interior at all — every
// pixel is an antialiased blend toward the background, so a pixel probe
// reports a washed-out colour and a correspondingly low ratio for text whose
// specified colour actually passes. Rendering at 3x gives each glyph stem a
// solid core to find, so the measurement reflects the real foreground rather
// than the rasteriser's edge blending.
test.use({ deviceScaleFactor: 3 });

const AA_NORMAL_TEXT_MIN = 4.5;

function assertAA(name: string, result: PixelMeasurement): void {
  const line = `${name}: fg=rgb(${result.fg}) bg=rgb(${result.bg}) ratio=${result.ratio.toFixed(2)}`;
  // Print every measurement regardless of pass/fail — this is the actual
  // real-pixel evidence for the PR review, not just a boolean.
  console.log(`[contrast] ${line}`);
  expect.soft(result.ratio, line).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MIN);
}

for (const mode of [
  { darkMode: false, label: "light" },
  { darkMode: true, label: "dark" },
] as const) {
  test(`meets WCAG AA (>=4.5:1) for say-this-card, phase rail, and coming-next preview in ${mode.label} mode`, async ({
    page,
  }) => {
    await mountFullCoach(page, { darkMode: mode.darkMode, withGuidance: false });

    // Live status pill in the topbar (Badge, border-emerald-200 /
    // text-emerald-700, visible whenever callStatus is "live" and not held
    // — true by default in this harness).
    const livePill = page.getByTestId("coach-live-pill");
    await expect(livePill).toBeVisible();
    assertAA("coach-live-pill status badge", await measureRenderedContrast(livePill));

    // EntryTokenChip's RESOLVED (non-placeholder) state — border-emerald-300
    // bg-emerald-50 text-emerald-700, a separate component from the plain
    // TokenChip covered below. Commit a value into offer_price so the chip
    // renders its resolved styling instead of the dashed placeholder.
    await page.getByTestId("entry-chip-offer_price").first().click();
    const entryInput = page.getByTestId("entry-input-offer_price");
    await entryInput.fill("210000");
    await entryInput.press("Enter");
    const entryChipResolved = page.getByTestId("entry-chip-offer_price").first();
    await expect(entryChipResolved).toBeVisible();
    await expect(entryChipResolved).toHaveText("210000");
    assertAA("EntryTokenChip resolved value", await measureRenderedContrast(entryChipResolved));

    // Completed phase label (coach-live-view.tsx CoachTopBar phase rail,
    // isComplete branch) — "introduction" is behind the harness's current
    // "offer" phase.
    const completedPhase = page.getByTestId("phase-rail-introduction");
    await expect(completedPhase).toBeVisible();
    await expect(completedPhase).toHaveText(/✓/);
    assertAA("completed phase label", await measureRenderedContrast(completedPhase));

    // Resolved token value inside the dominant "Say this" card (TokenChip,
    // the non-entry-token branch) — the offer phase's default "Good news"
    // branch resolves {seller_name} through this exact component.
    const sayThisCard = page.getByTestId("say-this-card");
    await expect(sayThisCard).toBeVisible();
    const tokenChipValue = sayThisCard.getByTestId("token-resolved").first();
    await expect(tokenChipValue).toBeVisible();
    assertAA("TokenChip resolved value in say-this-card", await measureRenderedContrast(tokenChipValue));

    // "Coming next" preview — deliberately de-emphasized relative to the
    // dominant say-this-card, but with an opaque mid-tone color rather than
    // the ancestor `opacity-45` that used to sit here.
    const nextLabel = page.getByTestId("next-phase-preview-label");
    const nextBody = page.getByTestId("next-phase-preview-body");
    await expect(nextLabel).toBeVisible();
    await expect(nextBody).toBeVisible();
    assertAA("coming-next preview label", await measureRenderedContrast(nextLabel));
    assertAA("coming-next preview body", await measureRenderedContrast(nextBody));

    // Current-phase pill while VIEWING a different phase (isCurrent &&
    // !isDisplayed) — override the displayed phase away from "offer" so
    // the offer pill renders its solid emerald "current" fill instead of
    // the primary "displayed" fill.
    await page.getByTestId("phase-rail-reveal").click();
    await expect(page.getByTestId("coach-viewing-phase")).toHaveText("Viewing · Reveal");
    // The phase-rail buttons use `transition-colors` — sampling pixels
    // immediately after the click that flips this button's classes can
    // land mid-animation (verified: a naive read here measured a real,
    // reproducible rgb(229,228,228) instead of the settled rgb(255,255,255)
    // text-white). Wait out Tailwind's default ~150ms transition before
    // measuring the settled, final color.
    await page.waitForTimeout(300);
    const currentWhileViewingOther = page.getByTestId("phase-rail-offer");
    await expect(currentWhileViewingOther).toBeVisible();
    assertAA("current-phase pill while viewing a different phase", await measureRenderedContrast(currentWhileViewingOther));

    // An INACTIVE phase label while HOVERED. Hover is a distinct rendered
    // state with its own background (`hover:bg-muted`), and measuring only
    // the resting state misses it entirely: muted-foreground on the muted
    // hover surface measured 4.40:1 — passing at rest, failing the moment
    // a pointer touches it. Every interactive text element whose colours
    // change on hover needs its hovered state measured too, not just its
    // default.
    const inactivePhase = page.getByTestId("phase-rail-close");
    await expect(inactivePhase).toBeVisible();
    await inactivePhase.hover();
    await page.waitForTimeout(300); // settle `transition-colors`
    assertAA("inactive phase label while hovered", await measureRenderedContrast(inactivePhase));
  });

  test(`meets WCAG AA (>=4.5:1) for tone cues and resolved guidance values in ${mode.label} mode`, async ({ page }) => {
    await mountFullCoach(page, { darkMode: mode.darkMode, withGuidance: true });

    const activeCard = page.locator('[data-testid="objection-card"][data-active="true"]');
    await expect(activeCard).toBeVisible();

    // Tone cue — ToneChip rendered inside the active objection card
    // (amber-400/15 tinted pill background).
    const toneChip = activeCard.getByTestId("tone-chip");
    await expect(toneChip).toBeVisible();
    assertAA("tone cue in active objection card", await measureRenderedContrast(toneChip));

    // Resolved token values inside the active objection card's guidance
    // text (ObjectionLine's resolved-segment span — a separate code path
    // from the TokenChip covered above).
    const resolvedValues = activeCard.getByTestId("token-resolved");
    const resolvedCount = await resolvedValues.count();
    expect(resolvedCount, "expected at least one resolved token value in the active objection card").toBeGreaterThan(0);
    for (let i = 0; i < resolvedCount; i++) {
      assertAA(`ObjectionLine resolved value #${i}`, await measureRenderedContrast(resolvedValues.nth(i)));
    }

    // "Coach nudge" label — a nudge only becomes the active/visible focus
    // surface once every objection card is dismissed (objections preempt
    // nudges by design), so dismiss all objection cards first.
    const objectionCards = page.locator('[data-testid="objection-card"]');
    let remaining = await objectionCards.count();
    while (remaining > 0) {
      await page.locator('[data-testid="objection-card"][data-active="true"]').click();
      remaining = await page.locator('[data-testid="objection-card"]:not([hidden])').count();
    }
    const nudge = page.locator('[data-testid="coach-nudge"][data-active="true"]');
    await expect(nudge).toBeVisible();
    const nudgeLabel = nudge.getByTestId("coach-nudge-label");
    await expect(nudgeLabel).toBeVisible();
    assertAA("coach-nudge label", await measureRenderedContrast(nudgeLabel));
  });

  test(`meets WCAG AA (>=4.5:1) for the held-call timer in ${mode.label} mode`, async ({ page }) => {
    await mountFullCoach(page, { darkMode: mode.darkMode, withGuidance: false, held: true });
    const timer = page.getByTestId("coach-call-timer");
    await expect(timer).toBeVisible();
    await expect(timer).toHaveText("On hold");
    assertAA("held-call timer", await measureRenderedContrast(timer));
  });
}
