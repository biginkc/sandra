import { expect, test } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import * as esbuild from "esbuild";
import Module from "node:module";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import postcss from "postcss";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MAX_NUDGES, MAX_OBJECTION_CARDS } from "../../src/lib/coach/event-reducer";
import { resolveCoachTokens } from "../../src/lib/coach/token-resolver";
import type { CoachCallContext, CoachNudge, CoachObjectionCard } from "../../src/lib/coach/types";

type CoachLiveViewModule = typeof import("../../src/components/coach/coach-live-view");

/**
 * Loads the REAL, on-disk GuidanceOverlay / CallControlDock components for
 * server rendering — NOT a hand-copied HTML approximation — without going
 * through Playwright's own TypeScript/JSX loader. Playwright's built-in
 * transform unconditionally points every .tsx file's automatic JSX runtime
 * at its OWN jsx-runtime (used internally for its ARIA-snapshot JSX
 * helpers), not React's — a plain `import` of a React component file here
 * produces Playwright's `{__pw_type: ...}` marker objects instead of real
 * React elements, which react-dom/server rejects. Bundling the component
 * with esbuild (react's automatic jsx runtime, explicit jsxImportSource)
 * and evaluating the bundle via node:vm — bypassing Node's require hooks
 * entirely — sidesteps that collision while still compiling the actual
 * source file on disk, transitive local imports included.
 */
function loadRealCoachComponents(): Pick<CoachLiveViewModule, "GuidanceOverlay" | "CallControlDock"> {
  const entryFile = path.resolve(process.cwd(), "src/components/coach/coach-live-view.tsx");
  const result = esbuild.buildSync({
    entryPoints: [entryFile],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    jsx: "automatic",
    jsxImportSource: "react",
    packages: "external", // react, lucide-react, @base-ui/react, etc. — real npm packages, required normally at eval time
    alias: { "@": path.resolve(process.cwd(), "src") },
    write: false,
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  const script = new vm.Script(Module.wrap(code), { filename: entryFile });
  const fn = script.runInThisContext();
  const mod = { exports: {} as Record<string, unknown> };
  fn(mod.exports, createRequire(entryFile), mod, path.dirname(entryFile), entryFile);
  return mod.exports as Pick<CoachLiveViewModule, "GuidanceOverlay" | "CallControlDock">;
}

const { GuidanceOverlay, CallControlDock } = loadRealCoachComponents();

let compiledCss = "";

test.beforeAll(async () => {
  const result = await postcss([tailwindcss()]).process(
    '@import "tailwindcss";',
    { from: path.resolve(process.cwd(), "src/app/globals.css") },
  );
  compiledCss = result.css;
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
});

const sampleContext: CoachCallContext = {
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main St",
  propertyCounty: "Jackson",
  repName: "Alex Rep",
  repPhoneE164: "+18165551234",
  motivation: null,
  leadId: "lead-1",
  sellerPhoneE164: "+18165559876",
  coldCallerName: null,
  yearBuilt: null,
  leadSource: "cold_call",
  occupancy: "owner_occupied",
};
const tokens = resolveCoachTokens(sampleContext);

// Exactly at the reducer's caps (event-reducer.ts) — the maximum the
// guidance stack is ever actually asked to lay out, since anything beyond
// this is dropped before it reaches the component.
const maxCards: CoachObjectionCard[] = ["price_too_low", "not_in_rush", "end_buyer"]
  .slice(0, MAX_OBJECTION_CARDS)
  .map((objectionId, index) => ({ id: `${objectionId}-${index}`, objectionId, ts: `t${index}`, expiresAt: Date.now() + 45_000 }));
const maxNudges: CoachNudge[] = ["First nudge.", "Second nudge.", "Third nudge, a little longer to stress the stack's height."]
  .slice(0, MAX_NUDGES)
  .map((text, index) => ({ id: `nudge-${index}`, text, phaseId: "introduction" as const, ts: `n${index}`, expiresAt: Date.now() + 20_000 }));

const dockProps = {
  callName: "Jane Homeowner",
  callStatus: "live" as const,
  seconds: 65,
  muted: false,
  held: false,
  holdPending: false,
  onDigit: () => {},
  onMute: () => {},
  onHold: () => {},
  onHangup: () => {},
  onCollapse: () => {},
};

const guidanceOverlayHtml = renderToStaticMarkup(
  createElement(GuidanceOverlay, {
    nudges: maxNudges,
    cards: maxCards,
    tokens,
    occupancy: sampleContext.occupancy,
    onDismissNudge: () => {},
    onDismissObjection: () => {},
  }),
);

/** Mirrors CoachLiveView's own layout: a flex-column full-height view with a
 * flex-1 filler standing in for the transcript/script area, so the dock
 * ends up genuinely pinned to the real viewport bottom, exactly like
 * production. */
function pageShell(...sections: string[]): string {
  return `
    <style>${compiledCss}</style>
    <div class="flex h-dvh flex-col">
      <div class="min-h-0 flex-1"></div>
      ${sections.join("\n")}
    </div>
  `;
}

test("keeps every call control, including Hang up, inside the 375px viewport and genuinely clickable when the keypad is closed", async ({ page }) => {
  const dockHtml = renderToStaticMarkup(createElement(CallControlDock, dockProps));
  await page.setContent(pageShell(dockHtml));

  for (const testId of ["coach-call-controls", "coach-mute", "coach-keypad-toggle", "coach-hold", "coach-hangup"]) {
    const el = page.getByTestId(testId);
    await expect(el).toBeInViewport();
    const box = await el.boundingBox();
    expect(box, `${testId} must have browser geometry`).not.toBeNull();
    expect(box!.x, `${testId} left edge`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${testId} right edge`).toBeLessThanOrEqual(375);
  }

  // A real Playwright click performs actionability hit-testing (visible,
  // stable, not obscured by anything else at that point) before dispatching
  // — it would time out here if some other element intercepted the click.
  await page.getByTestId("coach-mute").click();
  await page.getByTestId("coach-keypad-toggle").click();
  await page.getByTestId("coach-hold").click();
  await page.getByTestId("coach-hangup").click();
});

test("keeps the call dock genuinely clickable and never covered by the guidance stack at 375x812, even with all 3 objection cards, all 3 nudges, and the keypad open", async ({ page }) => {
  const dockOpenHtml = renderToStaticMarkup(createElement(CallControlDock, { ...dockProps, initialKeypadOpen: true }));
  await page.setContent(pageShell(guidanceOverlayHtml, dockOpenHtml));

  expect(await page.getByTestId("objection-card").count()).toBe(MAX_OBJECTION_CARDS);
  expect(await page.getByTestId("coach-nudge").count()).toBe(MAX_NUDGES);

  const stack = await page.getByTestId("coach-guidance-stack").boundingBox();
  const dockRow = await page.getByTestId("coach-call-dock-row").boundingBox();
  const keypad = await page.getByTestId("phone-keypad").boundingBox();
  expect(stack).not.toBeNull();
  expect(dockRow).not.toBeNull();
  expect(keypad).not.toBeNull();

  // The stack's own budget (top-20 + max-h-[40vh]) is what actually
  // guarantees this, independent of how much content is inside it.
  const viewportHeight = 812;
  expect(stack!.height).toBeLessThanOrEqual(viewportHeight * 0.4 + 1);
  expect(stack!.y + stack!.height).toBeLessThanOrEqual(80 + viewportHeight * 0.4 + 1);

  // Bottom containment: fully loaded, the stack still never reaches down
  // into the dock — keypad included, since an open keypad is the tallest
  // the dock ever gets.
  expect(stack!.y + stack!.height).toBeLessThanOrEqual(keypad!.y);
  expect(stack!.y + stack!.height).toBeLessThanOrEqual(dockRow!.y);

  for (const testId of ["coach-mute", "coach-keypad-toggle", "coach-hold", "coach-hangup"]) {
    const el = page.getByTestId(testId);
    await expect(el).toBeInViewport();
    const box = await el.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  }

  // Real clicks on the dock controls AND on keypad digits at the far
  // corners of its grid — if the guidance stack's containment regressed
  // and grew tall enough to overlap, these would time out as intercepted.
  await page.getByTestId("coach-mute").click();
  await page.getByTestId("coach-hold").click();
  await page.getByTestId("coach-hangup").click();
  await page.getByRole("button", { name: "Keypad 1" }).click();
  await page.getByRole("button", { name: "Keypad #" }).click();
});
