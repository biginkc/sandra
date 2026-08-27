import { expect, test } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";

const coachViewPath = path.resolve(
  process.cwd(),
  "src/components/coach/coach-live-view.tsx",
);
let compiledCss = "";
let coachViewSource = "";

test.beforeAll(async () => {
  coachViewSource = await readFile(coachViewPath, "utf8");
  const result = await postcss([tailwindcss()]).process(
    '@import "tailwindcss";',
    { from: path.resolve(process.cwd(), "src/app/globals.css") },
  );
  compiledCss = result.css;
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
});

test("finding 7 — every 375px coach call control, including Hang up, stays inside the viewport", async ({
  page,
}) => {
  expect(coachViewSource).toContain(
    'className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between"',
  );
  expect(coachViewSource).toContain(
    'className="grid grid-cols-2 gap-2 sm:flex sm:items-center"',
  );

  await page.setContent(`
    <style>${compiledCss}</style>
    <div class="flex shrink-0 flex-col gap-2 border-t px-4 py-3">
      <div class="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex min-w-0 items-center gap-3">
          <button type="button">Collapse</button>
          <div><div class="text-sm font-bold">Jane Homeowner</div><div class="font-mono text-xs">00:12</div></div>
        </div>
        <div data-testid="controls" class="grid grid-cols-2 gap-2 sm:flex sm:items-center">
          <button type="button" data-testid="mute">Mute</button>
          <button type="button" data-testid="keypad">Keypad</button>
          <button type="button" data-testid="hold">Hold</button>
          <button type="button" data-testid="hangup">Hang up</button>
        </div>
      </div>
    </div>
  `);

  for (const testId of ["controls", "mute", "keypad", "hold", "hangup"]) {
    const box = await page.getByTestId(testId).boundingBox();
    expect(box, `${testId} must have browser geometry`).not.toBeNull();
    expect(box!.x, `${testId} left edge`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${testId} right edge`).toBeLessThanOrEqual(375);
  }
  await expect(page.getByTestId("hangup")).toBeInViewport();
});

test("finding 8 — simultaneous 375px nudge and objection guidance share one non-overlapping stack", async ({
  page,
}) => {
  expect(coachViewSource).toContain(
    'className="pointer-events-none fixed top-20 right-4 z-[90] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"',
  );

  await page.setContent(`
    <style>${compiledCss}</style>
    <div data-testid="stack" class="pointer-events-none fixed top-20 right-4 z-[90] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      <div class="flex flex-col gap-2">
        <button data-testid="nudge" class="pointer-events-auto rounded-xl border px-3 py-2 text-left text-sm">Ask one more question before moving on.</button>
      </div>
      <div class="flex flex-col gap-2">
        <button data-testid="objection" class="pointer-events-auto rounded-2xl border p-3.5 text-left">
          <strong>Objection</strong>
          <p>Acknowledge — Yeah, I hear you.</p>
          <p>Disarm — I apologize that our offer was lower than we hoped.</p>
          <p>Overcome — What were you hoping I was at least going to say?</p>
        </button>
      </div>
    </div>
  `);

  const stack = await page.getByTestId("stack").boundingBox();
  const nudge = await page.getByTestId("nudge").boundingBox();
  const objection = await page.getByTestId("objection").boundingBox();
  expect(stack).not.toBeNull();
  expect(nudge).not.toBeNull();
  expect(objection).not.toBeNull();
  expect(stack!.x).toBeGreaterThanOrEqual(0);
  expect(stack!.x + stack!.width).toBeLessThanOrEqual(375);
  expect(nudge!.y + nudge!.height).toBeLessThanOrEqual(objection!.y);
  expect(objection!.x + objection!.width).toBeLessThanOrEqual(375);
});
