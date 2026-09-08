import { expect, test } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import * as esbuild from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";

let compiledCss = "";
let harnessBundle = "";

test.beforeAll(async () => {
  const globalsPath = path.resolve(process.cwd(), "src/app/globals.css");
  const globalsSource = await readFile(globalsPath, "utf8");
  const cssResult = await postcss([tailwindcss()]).process(globalsSource, { from: globalsPath });
  compiledCss = cssResult.css + ':root { --font-geist-sans: Inter, Arial, sans-serif; --font-geist-mono: "Geist Mono", monospace; }';
  const bundleResult = await esbuild.build({
    entryPoints: [path.resolve(process.cwd(), "e2e/synthetic/fixtures/dialer-coach-switch-harness.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    jsx: "automatic",
    jsxImportSource: "react",
    alias: {
      "@/lib/coach/recommendation-action": path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-recommendation-action-stub.ts"),
      "@": path.resolve(process.cwd(), "src"),
    },
    plugins: [{
      name: "synthetic-coach-browser-boundaries",
      setup(build) {
        build.onResolve({ filter: /coach-context-actions$/ }, () => ({
          path: path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-context-actions-browser-stub.ts"),
        }));
        build.onResolve({ filter: /supabase\/client$/ }, () => ({
          path: path.resolve(process.cwd(), "e2e/synthetic/fixtures/coach-supabase-browser-stub.ts"),
        }));
        build.onResolve({ filter: /dialer\/jitter-actions$|\.\/jitter-actions$/ }, () => ({
          path: path.resolve(process.cwd(), "e2e/synthetic/fixtures/jitter-actions-browser-stub.ts"),
        }));
        build.onResolve({ filter: /dialer\/actions$/ }, () => ({
          path: path.resolve(process.cwd(), "e2e/synthetic/fixtures/dialer-actions-browser-stub.ts"),
        }));
        build.onResolve({ filter: /^@telnyx\/webrtc$/ }, () => ({
          path: path.resolve(process.cwd(), "e2e/synthetic/fixtures/telnyx-webrtc-browser-stub.ts"),
        }));
      },
    }],
    define: {
      "process.env.NEXT_PUBLIC_SOFTPHONE_ALLOW_SIMULATED": '"false"',
      "process.env.VERCEL_ENV": '"development"',
      "process.env.NODE_ENV": '"test"',
      "process.env.NEXT_PUBLIC_SOFTPHONE_TRANSPORT": '"simulated"',
      "process.env.NEXT_PUBLIC_COACH_UI_ENABLED": '"1"',
    },
    write: false,
    logLevel: "silent",
  });
  harnessBundle = bundleResult.outputFiles[0].text;
  // A local copy lets the same production components be inspected by a person.
  await mkdir("tmp/dialer-switch-preview", { recursive: true });
  await writeFile("tmp/dialer-switch-preview/index.html", `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Geist+Mono:wght@500;600&display=swap" rel="stylesheet"><style>${compiledCss}</style><div id="root"></div><script>${harnessBundle}</script>`);

});

for (const width of [1440, 375]) {
  test(`coach switch layout and accessible script picker at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("http://synthetic.local/**", async (route) => {
      if (route.request().url().endsWith("mascot-writing.png")) return route.fulfill({ contentType: "image/png", body: await readFile("public/brand/mascot-writing.png") });
      await route.fulfill({ contentType: "text/html", body: `<style>${compiledCss}</style><div id="root"></div>` });
    });
    await page.goto("http://synthetic.local/");
    await page.addScriptTag({ content: harnessBundle });
    await page.getByTestId("header-dialer-button").click();
    const toggle = page.getByRole("switch", { name: "Enable live coach" });
    await expect(toggle).not.toBeChecked();
    const artwork = page.getByTestId("dialer-coach-mascot").locator("img");
    await expect.poll(() => artwork.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(artwork).toHaveCSS("object-fit", "contain");
    await expect(page.getByTestId("dialer-coach-script")).toHaveCount(0);
    const off = await page.getByTestId("dialer-input").boundingBox();
    await toggle.press("Space");
    await expect(toggle).toBeChecked();
    const picker = page.getByRole("combobox", { name: "Coach script" });
    await expect(picker).toContainText("CLOSR Outbound Sales Script");
    await expect(picker).toContainText("v1.2.1");
    await expect.poll(async () => (await page.getByTestId("dialer-input").boundingBox())!.y - off!.y).toBeGreaterThan(25);
    const mascot = (await page.getByTestId("dialer-coach-mascot").boundingBox())!;
    const headline = (await page.getByText("Want some help? Enable live coach.", { exact: true }).boundingBox())!;
    expect(mascot.y).toBeLessThanOrEqual(headline.y);
    await expect.poll(async () => {
      const imageBox = (await page.getByTestId("dialer-coach-mascot").boundingBox())!;
      const pickerBox = (await picker.boundingBox())!;
      return Math.abs(imageBox.y + imageBox.height - pickerBox.y - pickerBox.height);
    }).toBeLessThan(1);
    await picker.click();
    const option = page.getByRole("option");
    await expect(option).toBeVisible();
    await expect.poll(() => option.evaluate((row) => {
      const title = row.querySelector('[data-testid="coach-script-option-title"]')!.getBoundingClientRect();
      const version = row.querySelector('[data-testid="coach-script-option-version"]')!.getBoundingClientRect();
      const indicator = row.querySelector('svg')!.getBoundingClientRect();
      return title.right <= version.left && version.right <= indicator.left;
    })).toBe(true);
    await page.screenshot({ path: `tmp/dialer-switch-preview/menu-${width}.png` });
    await option.click(); // Must be above the dialer, not covered by its portal.
    await expect(option).toHaveCount(0);
    const bounds = await page.getByTestId("softphone-popover").boundingBox();
    for (const element of [toggle, picker]) {
      const box = (await element.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    }
    const contrast = await page.getByText("Sandra listens, keeps the script on screen, and suggests what to say next.").evaluate((sub) => {
      const luminance = (rgb: number[]) => rgb.map((c) => c / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      const background = luminance([12, 20, 38]);
      return [sub, sub.previousElementSibling!].map((el) => (luminance(getComputedStyle(el).color.match(/\d+/g)!.map(Number)) + 0.05) / (background + 0.05));
    });
    expect(Math.min(...contrast)).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: `tmp/dialer-switch-preview/on-${width}.png` });
    await toggle.click();
    await expect(picker).toHaveCount(0);
    await page.screenshot({ path: `tmp/dialer-switch-preview/off-${width}.png` });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("sandra.softphone.coach.v1")!))).toEqual({ enabled: false, scriptId: "closr-outbound" });
  });
}
