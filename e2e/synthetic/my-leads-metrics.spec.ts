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
    const strip = page.getByTestId("sticky-metrics")
    await expect(strip).toHaveCount(0)
    // Align the fixture's fractional text height to a scrollable CSS pixel so
    // the exact edge-adjacent observer transition below is deterministic.
    await page.getByTestId("expanded-metrics").evaluate(node => {
      node.style.height = `${Math.ceil(node.getBoundingClientRect().height)}px`
    })
    const expanded = await page.getByTestId("expanded-metrics").boundingBox()
    const inset = width < 768 ? 116 : 64
    await page.evaluate(y => window.scrollTo(0, y), expanded!.y + expanded!.height - inset + 40)
    await expect(strip).toBeVisible()
    const stickyBox = await strip.boundingBox()
    expect(stickyBox!.y).toBeCloseTo(inset, 0)
    expect(stickyBox!.x).toBeGreaterThanOrEqual(width < 768 ? 0 : 256)
    expect(stickyBox!.x + stickyBox!.width).toBeLessThanOrEqual(width)
    await expect(strip.locator("dt")).toHaveCount(9)
    await expect(strip).toContainText("8 / 25")
    await expect(strip).toContainText("3m 42s")
    const positions = await strip.locator("dt").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top))
    expect(new Set(positions).size).toBe(1)
    await strip.focus()
    await strip.evaluate(node => { node.scrollLeft = node.scrollWidth })
    await expect(strip.getByText("Over 5 min", {exact: true})).toBeInViewport()
    await page.evaluate(() => window.scrollBy(0, 400))
    expect((await strip.boundingBox())!.y).toBeCloseTo(inset, 0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await strip.evaluate(node => { node.scrollLeft = 0; node.blur() })
    await page.screenshot({ path: `/tmp/my-leads-sticky-metrics-${width}.png`, fullPage: false })
    // Returning through an edge-adjacent intersection must clear the strip.
    // At this position the cards have zero intersection area but are intersecting.
    await page.evaluate(y => window.scrollTo(0, y), expanded!.y + expanded!.height - inset)
    await expect.poll(async () => (await page.getByTestId("expanded-metrics").boundingBox())!.y + expanded!.height).toBeCloseTo(inset, 0)
    await expect(strip).toHaveCount(0)
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(strip).toHaveCount(0)
  })
}
