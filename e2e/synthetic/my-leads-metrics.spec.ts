import { readFileSync } from "node:fs"
import path from "node:path"
import { expect, test } from "@playwright/test"
import tailwindcss from "@tailwindcss/postcss"
import postcss from "postcss"
import * as esbuild from "esbuild"
let css = ""
let js = ""
test.beforeAll(async () => {
  css = (await postcss([tailwindcss()]).process(readFileSync("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css
  js = (await esbuild.build({ entryPoints: ["e2e/synthetic/fixtures/my-leads-metrics-harness.tsx"], bundle: true, platform: "browser", format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"test"' }, write: false })).outputFiles[0].text
})
for (const width of [390, 1440]) {
  test(`nine metrics are readable and contained at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.setContent(`<style>${css}</style><div id="root"></div>`)
    await page.addScriptTag({ content: js })
    await expect(page.locator('[data-testid^="kpi-"]')).toHaveCount(9)
    await expect(page.getByTestId("kpi-contacts")).toContainText("8 / 25")
    await expect(page.getByTestId("kpi-average-talk-time")).toContainText("3m 42s")
    for (const card of await page.locator('[data-testid^="kpi-"]').all()) {
      const box = await card.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const first = await page.getByTestId("kpi-contact-without-follow-up").boundingBox()
    const second = await page.getByTestId("kpi-needs-offers").boundingBox()
    if (width === 390) expect(second!.y).toBeGreaterThan(first!.y)
    else expect(second!.y).toBe(first!.y)
    await page.screenshot({ path: `/tmp/my-leads-metrics-${width}.png`, fullPage: true })
  })
}
