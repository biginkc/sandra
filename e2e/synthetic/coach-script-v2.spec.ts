import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import * as esbuild from "esbuild";
import postcss from "postcss";

let css = "";
const bundles = new Map<"off" | "on", string>();

test.beforeAll(async () => {
  const globalsPath = path.resolve(process.cwd(), "src/app/globals.css");
  css = (await postcss([tailwindcss()]).process(await readFile(globalsPath, "utf8"), { from: globalsPath })).css;
  for (const mode of ["off", "on"] as const) {
    const output = await esbuild.build({
      entryPoints: [path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-live-responsive-harness.tsx")],
      bundle: true,
      platform: "browser",
      external: ["crypto"],
      format: "iife",
      target: "chrome120",
      jsx: "automatic",
      jsxImportSource: "react",
      alias: {
        "@/lib/coach/recommendation-action": path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-recommendation-action-stub.ts"),
        "@": path.resolve(process.cwd(), "src"),
      },
      define: {
        "process.env.NODE_ENV": '"test"',
        ...(mode === "off" ? { "process.env.NEXT_PUBLIC_COACH_SCRIPT_V2": '""' } : {}),
        "process.env.NEXT_PUBLIC_COACH_WIRE_DIGEST_STRICT": '""',
      },
      // Test-only process shape for the V2-on browser bundle. Keeping the
      // direct lookup intact here proves the no-process production guard.
      banner: mode === "on"
        ? { js: 'var process = { env: { NEXT_PUBLIC_COACH_SCRIPT_V2: "1" } };' }
        : undefined,
      write: false,
      logLevel: "silent",
    });
    bundles.set(mode, output.outputFiles[0]!.text);
  }
});

async function mount(page: Page, mode: "off" | "on", data = ""): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`<style>${css}</style><div id="root" ${data}></div>`);
  await page.addScriptTag({ content: bundles.get(mode)! });
  await expect(page.getByTestId("coach-live-view")).toBeVisible();
  // Capture the requested review screenshots after Base UI's opening
  // transition has composited, rather than recording a faded first frame.
  await page.waitForTimeout(350);
}

test("flag off preserves the S4 card while flag on renders three columns and the bound ref", async ({ page }) => {
  await mount(page, "off");
  await expect(page.getByTestId("coach-script-v2-panel")).toHaveCount(0);
  await expect(page.getByTestId("current-script-card")).toBeVisible();

  await mount(page, "on");
  await expect(page.getByTestId("coach-script-v2-panel")).toBeVisible();
  await expect(page.getByTestId("coach-script-ref-label")).toHaveText("closr-outbound@1 · locked for this call");
  await expect(page.getByTestId("coach-script-ref")).toBeHidden();
  await expect(page.getByTestId("coach-powered-by-closer-lab")).toContainText("Powered by");
  await expect(page.getByAltText("Closer Lab")).toHaveAttribute("src", "/brand/closer-lab-logo.svg");
  const transcript = await page.getByLabel("Live transcript").boundingBox();
  const script = await page.getByTestId("coach-script-v2-panel").boundingBox();
  const recommendations = await page.getByTestId("coach-recommendations").boundingBox();
  expect(transcript!.x + transcript!.width).toBeLessThanOrEqual(script!.x + 1);
  expect(script!.x + script!.width).toBeLessThanOrEqual(recommendations!.x + 1);
  await page.screenshot({ path: path.resolve(process.cwd(), ".planning/claude-convergence/pr-s5-screens/main.png"), fullPage: true });
});

test("v2 navigation, variants, and editable tokens work mid-call", async ({ page }) => {
  await mount(page, "on", 'data-empty-motivation="true"');
  await page.getByTestId("coach-next").click();
  await expect(page.getByTestId("current-section-title")).toHaveText("Set the qualification frame");
  await page.getByTestId("coach-back").click();
  await expect(page.getByTestId("current-section-title")).toHaveText("Open the call");
  const motivation = page.getByTestId("coach-token-motivation");
  // One native input event mirrors a paste and proves the package's editable
  // token contract without depending on key-by-key composition behavior.
  await motivation.evaluate((input: HTMLInputElement) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, "Downsize near family");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.getByTestId("current-section-script")).toContainText("Downsize near family");
  await page.getByTestId("variant-Opener-fsbo").click();
  await expect(page.getByTestId("variant-Opener-fsbo")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("coach-hold").click();
  await page.screenshot({ path: path.resolve(process.cwd(), ".planning/claude-convergence/pr-s5-screens/multipath-hold.png"), fullPage: true });
});

test("v2 unavailable leaves the live transcript and hangup control usable", async ({ page }) => {
  await mount(page, "on", 'data-unavailable="true"');
  await expect(page.getByTestId("coach-script-unavailable")).toBeVisible();
  await expect(page.getByTestId("coach-transcript")).toContainText("Walk me through");
  await page.screenshot({ path: path.resolve(process.cwd(), ".planning/claude-convergence/pr-s5-screens/script-unavailable.png"), fullPage: true });
  await page.getByTestId("coach-hangup").click();
  await expect.poll(() => page.locator("#root").getAttribute("data-hungup")).toBe("true");
});
