import { expect, test, type Locator, type Page } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import * as esbuild from "esbuild";
import path from "node:path";
import postcss from "postcss";

// Regression coverage for a WCAG AA contrast failure (PR #414 merge-gate
// review): the focus-mode redesign introduced emerald/amber foreground
// text colors that read fine against bare Tailwind swatches but fell
// below 4.5:1 once measured against Sandra's actual production theme
// tokens (--card, the amber-400/15 tint, etc). This harness compiles the
// real globals.css (which pulls in sandra-tokens.css) and hydrates the
// real CoachLiveView, then computes contrast the same way a browser
// renders it: walk up the DOM compositing every ancestor's
// background-color (respecting alpha) down to the page's true
// background, and check the element's own resolved text color against
// that composited result. This is what would have caught the regression
// — a bare `text-emerald-600` vs. `#ffffff` unit check would not, because
// the failure only exists once the tinted/production backdrop is real.
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

/** WCAG relative-luminance contrast ratio between two opaque sRGB colors. */
const CONTRAST_SCRIPT = `
  function srgbToLin(c) {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function luminance([r, g, b]) {
    return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
  }
  function contrastRatio(fg, bg) {
    const L1 = luminance(fg);
    const L2 = luminance(bg);
    const lighter = Math.max(L1, L2);
    const darker = Math.min(L1, L2);
    return (lighter + 0.05) / (darker + 0.05);
  }
  // getComputedStyle().color / .backgroundColor come back as oklch(...) for
  // Tailwind v4's default palette (emerald/amber), not rgb(...) — a naive
  // rgb()/rgba() regex silently falls through to a white/transparent
  // fallback and the test would pass on nothing. Rasterizing 1x1 through a
  // real canvas 2D context resolves any CSS color (oklch, color(), named,
  // rgb) to concrete sRGB bytes the same way the browser paints it.
  const swatch = document.createElement("canvas");
  swatch.width = 1;
  swatch.height = 1;
  const swatchCtx = swatch.getContext("2d");
  function parseColor(str) {
    if (!str || str === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    swatchCtx.clearRect(0, 0, 1, 1);
    swatchCtx.fillStyle = str;
    swatchCtx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = swatchCtx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  }
  function effectiveBackground(el) {
    const chain = [];
    let node = el;
    while (node) {
      chain.push(getComputedStyle(node).backgroundColor);
      node = node.parentElement;
    }
    let result = [255, 255, 255];
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = parseColor(chain[i]);
      if (c.a === 0) continue;
      result = [
        c.a * c.r + (1 - c.a) * result[0],
        c.a * c.g + (1 - c.a) * result[1],
        c.a * c.b + (1 - c.a) * result[2],
      ];
    }
    return result;
  }
  window.__coachContrast = function (el) {
    const cs = getComputedStyle(el);
    const fg = parseColor(cs.color);
    const bg = effectiveBackground(el);
    const ratio = contrastRatio([fg.r, fg.g, fg.b], bg);
    return { ratio, fg: [Math.round(fg.r), Math.round(fg.g), Math.round(fg.b)], bg: bg.map((n) => Math.round(n)) };
  };
`;

async function mountFullCoach(page: Page, darkMode: boolean): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`
    <style>${compiledCss}</style>
    <div id="root" data-guidance="true"></div>
  `);
  // Real app puts `.dark` on <html>, so the whole document — not just a
  // wrapper div — resolves the dark theme tokens, matching production.
  await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), darkMode);
  await page.addScriptTag({ content: harnessBundle });
  await page.addScriptTag({ content: CONTRAST_SCRIPT });
  await expect(page.getByTestId("coach-live-view")).toBeVisible();
}

async function measureContrast(
  locator: Locator,
): Promise<{ ratio: number; fg: [number, number, number]; bg: [number, number, number] }> {
  return locator.evaluate((el) => (window as unknown as { __coachContrast: (el: Element) => { ratio: number; fg: [number, number, number]; bg: [number, number, number] } }).__coachContrast(el));
}

const AA_NORMAL_TEXT_MIN = 4.5;

for (const mode of [
  { darkMode: false, label: "light" },
  { darkMode: true, label: "dark" },
] as const) {
  test(`meets WCAG AA (>=4.5:1) for completed phase labels, tone cues, and resolved guidance values in ${mode.label} mode`, async ({
    page,
  }) => {
    await mountFullCoach(page, mode.darkMode);

    // Completed phase label — "introduction" is behind the harness's
    // current "offer" phase, so it renders with the completed-phase
    // emerald text color (coach-live-view.tsx, CoachTopBar phase rail).
    const completedPhase = page.getByTestId("phase-rail-introduction");
    await expect(completedPhase).toBeVisible();
    await expect(completedPhase).toHaveText(/✓/);
    const phaseResult = await measureContrast(completedPhase);
    expect(
      phaseResult.ratio,
      `completed phase label fg=${phaseResult.fg} bg=${phaseResult.bg} ratio=${phaseResult.ratio.toFixed(2)}`,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MIN);

    // Tone cue — the ToneChip rendered inside the active objection card
    // (amber-400/15 tinted pill background, ToneChip in coach-live-view.tsx).
    const activeCard = page.locator('[data-testid="objection-card"][data-active="true"]');
    await expect(activeCard).toBeVisible();
    const toneChip = activeCard.getByTestId("tone-chip");
    await expect(toneChip).toBeVisible();
    const toneResult = await measureContrast(toneChip);
    expect(
      toneResult.ratio,
      `tone cue fg=${toneResult.fg} bg=${toneResult.bg} ratio=${toneResult.ratio.toFixed(2)}`,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MIN);

    // Resolved token values inside the active objection card's guidance
    // text (ObjectionLine's resolved-segment span in coach-live-view.tsx).
    const resolvedValues = activeCard.getByTestId("token-resolved");
    const resolvedCount = await resolvedValues.count();
    expect(resolvedCount, "expected at least one resolved token value in the active objection card").toBeGreaterThan(0);
    for (let i = 0; i < resolvedCount; i++) {
      const el = resolvedValues.nth(i);
      const result = await measureContrast(el);
      expect(
        result.ratio,
        `resolved guidance value #${i} fg=${result.fg} bg=${result.bg} ratio=${result.ratio.toFixed(2)}`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MIN);
    }
  });
}
