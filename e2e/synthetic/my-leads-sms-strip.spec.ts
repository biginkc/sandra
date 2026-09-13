import { expect, test } from "@playwright/test"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import * as esbuild from "esbuild"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

let html = ""
test.beforeAll(async () => {
  const globalPath = path.resolve("src/app/globals.css")
  const css = await postcss([tailwindcss()]).process(readFileSync(globalPath, "utf8"), { from: globalPath })
  const bundle = await esbuild.build({
    entryPoints: [path.resolve("e2e/synthetic/fixtures/my-leads-sms-harness.tsx")],
    bundle: true, platform: "browser", format: "iife", target: "chrome120", jsx: "automatic", write: false,
    alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
    // This proof exercises the actual row and strip. Unrelated record editors
    // below the row are omitted so this fixture cannot call server actions.
    plugins: [{ name: "omit-record-editors", setup(build) {
      build.onResolve({ filter: /^\.\/detail-panel$/ }, () => ({ path: "detail-panel", namespace: "sms-fixture" }))
      build.onLoad({ filter: /.*/, namespace: "sms-fixture" }, () => ({ contents: "export function MyLeadDetailPanel() { return null }", loader: "js" }))
    } }],
  })
  html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}\n:root{--font-geist-sans:Arial,sans-serif;--font-geist-mono:monospace}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`
  mkdirSync("test-results/my-leads-sms", { recursive: true })
  writeFileSync("test-results/my-leads-sms/preview.html", html)
})

for (const width of [1440, 390]) {
  test(`SMS strip wraps and opens complete text at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 })
    await page.setContent(html)
    const list = page.getByRole("list", { name: "Text message history" })
    await expect(list.getByRole("listitem")).toHaveCount(7)
    const positions = await list.getByRole("listitem").evaluateAll(items => items.map(item => ({ x: item.getBoundingClientRect().x, y: item.getBoundingClientRect().y })))
    if (width > 400) expect(positions[1].y).toBe(positions[0].y)
    expect(positions.at(-1)!.y).toBeGreaterThan(positions[0].y)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await list.getByRole("button").last().click()
    const popup = page.getByRole("dialog")
    await expect(popup).toContainText("property-details-".repeat(35))
    await expect(popup).toContainText("Sep 13, 2026")
    const box = await popup.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.keyboard.press("Escape")
    await expect(popup).not.toBeVisible()
    await page.getByRole("button", { name: "Load earlier texts" }).click()
    await expect(list.getByRole("listitem")).toHaveCount(8)
    await expect(list.getByRole("listitem").first()).toContainText("Hello, is this Alex?")
    await page.screenshot({ path: `test-results/my-leads-sms/${width}.png`, fullPage: true })
  })
}
