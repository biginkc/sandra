import { expect, test } from "@playwright/test";
import * as esbuild from "esbuild";
import path from "node:path";

let bundle = "";
test.beforeAll(() => {
  bundle = esbuild.buildSync({
    entryPoints: ["e2e/synthetic/fixtures/call-history-harness.tsx"],
    bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@": path.resolve("src") },
    define: { "process.env.NODE_ENV": '"test"' }, write: false,
  }).outputFiles[0].text;
});

for (const width of [390, 1440]) {
  for (const missing of [false, true]) {
    test(`provider actions at ${width}px with ${missing ? "missing" : "configured"} destination`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route("https://history.test/**", (route) => route.fulfill({
        contentType: "text/html", body: '<!doctype html><div id="root"></div>',
      }));
      await page.goto(`https://history.test/${missing ? "?missing" : ""}`);
      await page.addScriptTag({ content: bundle });
      for (const provider of ["dialpad", "sandra_softphone", "unknown"]) {
        const card = page.getByRole("region", { name: provider, exact: true });
        await expect(card.getByText("Connected", { exact: true })).toBeVisible();
        await expect(card.getByText("Open in Jitter")).toHaveCount(0);
      }
      const jitter = page.getByRole("region", { name: "jitter", exact: true });
      await expect(jitter.getByRole("link", { name: "Open call in Jitter" })).toHaveCount(missing ? 0 : 1);
      if (!missing) await expect(jitter.getByRole("link")).toHaveAttribute("href", "https://jitter.example.test/history?prospect_id=property-123");
      await expect(page.getByRole("button", { name: "Open in Jitter" })).toHaveCount(0);
    });
  }
}
