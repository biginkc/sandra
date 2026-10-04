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
    entryPoints: [path.resolve("e2e/synthetic/fixtures/my-leads-call-next-harness.tsx")],
    bundle: true, platform: "browser", format: "iife", target: "chrome120", jsx: "automatic", write: false,
    alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
  })
  html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}\n:root{--font-geist-sans:Arial,sans-serif;--font-geist-mono:monospace}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`
  mkdirSync("test-results/my-leads-call-next", { recursive: true })
  writeFileSync("test-results/my-leads-call-next/preview.html", html)
})

const rowIds = (page: import("@playwright/test").Page) =>
  page.locator("[data-testid='call-next-strip'] ol > [data-testid^='call-next-row-']").evaluateAll((els) => els.map((el) => el.getAttribute("data-property-id")))

for (const width of [1440, 390]) {
  test(`the Call next strip renders above the page content and never overflows at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.setContent(html)
    const strip = page.getByTestId("call-next-strip")
    await expect(strip).toBeVisible()
    expect(await rowIds(page)).toEqual(["overdue", "inbound", "offer", "stale"])
    await expect(page.getByTestId("call-next-reason-overdue")).toHaveText("Callback 2 days overdue")
    await expect(page.getByTestId("call-next-reason-inbound")).toHaveText("Texted you 2h ago")
    await expect(page.getByTestId("call-next-reason-offer")).toHaveText("Offer follow-up 3d overdue")
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/my-leads-call-next/${width}.png`, fullPage: true })
  })
}

test("the row menu is keyboard operable and Call today moves the lead to the top", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.setContent(html)
  await page.getByTestId("call-next-menu-stale").focus()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("call-next-action-call-today-stale")).toBeVisible()
  await page.keyboard.press("Enter")   // first item is Call today
  await expect(page.getByTestId("harness-log")).toContainText("call-today:stale")
  expect(await rowIds(page)).toEqual(["stale", "overdue", "inbound", "offer"])
  await expect(page.getByTestId("call-next-reason-stale")).toHaveText("Pinned: call today")
})

test("Not today hides the lead and counts it; Dead / Nurture and Call reach their handlers; triage opens", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.setContent(html)
  await page.getByTestId("call-next-menu-inbound").click()
  await page.getByTestId("call-next-action-not-today-inbound").click()
  expect(await rowIds(page)).toEqual(["overdue", "offer", "stale"])
  await expect(page.getByTestId("call-next-hidden")).toHaveText("1 hidden today")
  await page.getByTestId("call-next-menu-offer").click()
  await page.getByTestId("call-next-action-dead-nurture-offer").click()
  await page.getByTestId("call-next-action-call-overdue").click()
  await expect(page.getByTestId("harness-log")).toContainText("dead-nurture:offer")
  await expect(page.getByTestId("harness-log")).toContainText("call:overdue")
  await page.getByTestId("call-next-excluded-toggle").click()
  await expect(page.getByTestId("call-next-excluded")).toContainText("5 Pine Street")
  await page.getByTestId("call-next-triage-chip").click()
  await expect(page.getByTestId("call-next-row-old")).toBeVisible()
})
