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
 * composited background, from actual rendered pixels.
 *
 * The hard part is knowing which pixels ARE text. This builds a complete
 * glyph mask by rendering the element three times: once with every
 * descendant's `color` forced BLACK, once forced WHITE, and once with the
 * text hidden entirely. Any coordinate that differs between the black and
 * white passes is covered by a glyph — that holds no matter what colour the
 * text actually is or what sits behind it. Coordinates that are FULLY black
 * in one pass and FULLY white in the other are solid glyph core rather than
 * anti-aliased edge, and only those are measured.
 *
 * Contrast is then evaluated PER COORDINATE — foreground from the normal
 * render, background from the hidden-text render at that same point — and
 * the WORST ratio found is what gets reported. Never an average: averaging
 * across a split background reports a comfortable mean for text that is
 * illegible over half its own run.
 *
 * Two earlier versions of this file were defeated by real mutations, and
 * both failures are why it now works this way:
 *
 *   1. Comparing every candidate pixel against a SINGLE centre background
 *      pixel let anything different from that one point pose as text. The
 *      Live badge's emerald border outvoted its own glyphs, so degrading
 *      that text to 3.26:1 still reported the border's 13.67:1 and passed.
 *
 *   2. Treating "unchanged when the text is hidden" as "not text" discarded
 *      precisely the worst case: text already invisible against its
 *      background does not change when you hide it. Black text over a
 *      black-and-white split had its invisible half thrown away and passed
 *      at 21:1. Forcing black and white passes finds glyphs by their shape
 *      instead of by their visibility, so invisible text is still measured
 *      — and measured at the ratio it deserves.
 *
 * Descendants are included via `* { color: ... !important }` scoped to the
 * element, so text whose colour is set on a child is masked too rather than
 * being silently skipped.
 */
async function measureRenderedContrast(locator: Locator): Promise<PixelMeasurement> {
  // Decorative `aria-hidden` descendants are exempt from the text-contrast
  // rule and must not enter the mask. `visibility: hidden` (not `display:
  // none`) so layout — and therefore glyph position — is byte-identical
  // across all passes.
  await locator.evaluate((el) => {
    el.querySelectorAll<HTMLElement>('[aria-hidden="true"]').forEach((node, index) => {
      node.dataset.contrastProbeOrigVisibility = node.style.visibility;
      node.dataset.contrastProbeHidden = String(index);
      node.style.visibility = "hidden";
    });
  });

  const applyColor = (color: string | null) =>
    locator.evaluate((el, value) => {
      const id = "contrast-probe-style";
      document.getElementById(id)?.remove();
      if (value === null) return;
      el.setAttribute("data-contrast-probe-target", "");
      const style = document.createElement("style");
      style.id = id;
      // Descendants included: text coloured by a child element must be
      // masked too, or it is measured as background and silently passes.
      style.textContent = `[data-contrast-probe-target], [data-contrast-probe-target] * { color: ${value} !important; }`;
      document.head.appendChild(style);
    }, color);

  const shot = () => locator.screenshot({ animations: "disabled" });

  const normal = await shot();
  await applyColor("#000000");
  const blackPass = await shot();
  await applyColor("#ffffff");
  const whitePass = await shot();
  await applyColor("transparent");
  const hidden = await shot();
  await applyColor(null);

  await locator.evaluate((el) => {
    el.removeAttribute("data-contrast-probe-target");
    el.querySelectorAll<HTMLElement>("[data-contrast-probe-hidden]").forEach((node) => {
      node.style.visibility = node.dataset.contrastProbeOrigVisibility ?? "";
      delete node.dataset.contrastProbeOrigVisibility;
      delete node.dataset.contrastProbeHidden;
    });
  });

  const [normalImg, blackImg, whiteImg, hiddenImg] = await Promise.all(
    [normal, blackPass, whitePass, hidden].map((buf) =>
      sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ),
  );
  const { width, height, channels } = normalImg.info;
  for (const img of [blackImg, whiteImg, hiddenImg]) {
    if (img.info.width !== width || img.info.height !== height) {
      throw new Error("contrast probe screenshots changed size between passes — element must have resized");
    }
  }

  // Solid glyph core: fully inked in both forced passes. An anti-aliased
  // edge pixel is a partial blend and fails this, which is what we want —
  // WCAG applies to the text colour, not to the rasteriser's edge fade.
  const SOLID = 12; // tolerance for "fully black" / "fully white"
  let worst: { ratio: number; fg: [number, number, number]; bg: [number, number, number] } | null = null;
  let solidCount = 0;

  for (let i = 0; i < width * height; i++) {
    const idx = i * channels;
    const isBlack =
      blackImg.data[idx] <= SOLID && blackImg.data[idx + 1] <= SOLID && blackImg.data[idx + 2] <= SOLID;
    const isWhite =
      whiteImg.data[idx] >= 255 - SOLID &&
      whiteImg.data[idx + 1] >= 255 - SOLID &&
      whiteImg.data[idx + 2] >= 255 - SOLID;
    if (!isBlack || !isWhite) continue;
    solidCount += 1;

    const fg: [number, number, number] = [normalImg.data[idx], normalImg.data[idx + 1], normalImg.data[idx + 2]];
    const bg: [number, number, number] = [hiddenImg.data[idx], hiddenImg.data[idx + 1], hiddenImg.data[idx + 2]];
    const ratio = contrastRatio(fg, bg);
    if (!worst || ratio < worst.ratio) worst = { ratio, fg, bg };
  }

  if (!worst || solidCount === 0) {
    throw new Error(
      "contrast probe found no solid glyph pixels — the element rendered no measurable text (check the locator)",
    );
  }
  return worst;
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

    // Two-tone transcript speaker labels (mock parity) — rep in the
    // emerald accent, seller in amber, against the transcript aside's
    // actual bg-muted/30 composited background. The harness fixture always
    // seeds one rep line and one seller line.
    const repLabel = page.getByTestId("transcript-speaker-label").filter({ hasText: "Rep" }).first();
    const sellerLabel = page.getByTestId("transcript-speaker-label").filter({ hasText: "Seller" }).first();
    await expect(repLabel).toBeVisible();
    await expect(sellerLabel).toBeVisible();
    assertAA("transcript rep speaker label", await measureRenderedContrast(repLabel));
    assertAA("transcript seller speaker label", await measureRenderedContrast(sellerLabel));

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

// ---------------------------------------------------------------------------
// Negative controls for the probe itself.
//
// A contrast test that cannot fail is worse than no contrast test, because it
// converts an unmeasured risk into a false assurance. Two earlier versions of
// this file passed while the text they were pointed at was genuinely
// unreadable, and both were caught by an outside reviewer mutating the source
// rather than by anything committed here. These fixtures encode the four ways
// the probe has been — or could plausibly be — defeated, so a future change
// that reintroduces any of them fails immediately and locally.
//
// Each control asserts the probe REPORTS A LOW RATIO for text that is in fact
// unreadable. They are deliberately not assertions about the product.
// ---------------------------------------------------------------------------
async function mountProbeFixture(page: Page, html: string): Promise<void> {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(`<style>${compiledCss}</style><div id="fixture">${html}</div>`);
}

test.describe("contrast probe negative controls", () => {
  test("detects text that is invisible against its own background", async ({ page }) => {
    await mountProbeFixture(
      page,
      `<div data-testid="probe" style="background:#ffffff;color:#ffffff;font-size:20px;padding:12px">Invisible</div>`,
    );
    const { ratio } = await measureRenderedContrast(page.getByTestId("probe"));
    expect(ratio).toBeLessThan(1.5);
  });

  test("detects the unreadable half of a split background", async ({ page }) => {
    // Black text over a half-black/half-white background. An averaging probe,
    // or one that discards pixels which do not change when the text is
    // hidden, reports a comfortable pass here — the black-on-black half is
    // exactly the half it throws away.
    await mountProbeFixture(
      page,
      `<div data-testid="probe" style="background:linear-gradient(90deg,#000 0 50%,#fff 50% 100%);color:#000000;font-size:20px;padding:12px">Half of this is invisible</div>`,
    );
    const { ratio } = await measureRenderedContrast(page.getByTestId("probe"));
    expect(ratio).toBeLessThan(1.5);
  });

  test("detects low-contrast text whose colour is set on a descendant", async ({ page }) => {
    // The wrapper is perfectly readable; the inner span is not. A probe that
    // only forces `color` on the element itself never masks the child's
    // glyphs and silently reports the wrapper.
    await mountProbeFixture(
      page,
      `<div data-testid="probe" style="background:#ffffff;color:#111111;font-size:20px;padding:12px">Readable <span style="color:#eeeeee">unreadable</span></div>`,
    );
    const { ratio } = await measureRenderedContrast(page.getByTestId("probe"));
    expect(ratio).toBeLessThan(4.5);
  });

  test("is not fooled by a high-contrast decorative pseudo-element", async ({ page }) => {
    // Generated content in `currentColor` is a decoration, not text. A probe
    // that measures whatever is most colourful reports the decoration's
    // contrast and passes while the real text is illegible.
    await mountProbeFixture(
      page,
      `<style>#deco::before{content:"";display:inline-block;width:40px;height:20px;background:#000000;vertical-align:middle}</style>
       <div data-testid="probe" id="deco" style="background:#ffffff;color:#f0f0f0;font-size:20px;padding:12px">Faint text</div>`,
    );
    const { ratio } = await measureRenderedContrast(page.getByTestId("probe"));
    expect(ratio).toBeLessThan(4.5);
  });

  test("passes genuinely readable text (guards against always-fail)", async ({ page }) => {
    // The complement of the controls above: a probe wired to fail everything
    // would satisfy all four and still be useless.
    await mountProbeFixture(
      page,
      `<div data-testid="probe" style="background:#ffffff;color:#1c1917;font-size:20px;padding:12px">Clearly readable</div>`,
    );
    const { ratio } = await measureRenderedContrast(page.getByTestId("probe"));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
