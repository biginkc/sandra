import { expect, test, type Page } from "@playwright/test"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import * as esbuild from "esbuild"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

const SHOTS = "test-results/my-leads-unified-queue"
let html = ""

test.beforeAll(async () => {
  const globalPath = path.resolve("src/app/globals.css")
  const css = await postcss([tailwindcss()]).process(readFileSync(globalPath, "utf8"), { from: globalPath })
  const stubs: Record<string, string> = {
    // The queue's server-bound neighbours are replaced so this proof cannot reach a server action.
    "rep-sms-composer": "export function RepSmsComposer() { return null }",
    "drip-picker": "export function AfterAttemptDripPicker() { return null }",
    "next-link": "import React from 'react'; export default function Link({ href, children, ...rest }) { return React.createElement('a', { href, ...rest }, children) }",
  }
  const bundle = await esbuild.build({
    entryPoints: [path.resolve("e2e/synthetic/fixtures/my-leads-unified-queue-harness.tsx")],
    bundle: true, platform: "browser", format: "iife", target: "chrome120", jsx: "automatic", write: false,
    alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
    plugins: [{ name: "omit-server-neighbours", setup(build) {
      build.onResolve({ filter: /rep-sms-composer$/ }, () => ({ path: "rep-sms-composer", namespace: "unified-fixture" }))
      build.onResolve({ filter: /after-attempt-drip-picker$/ }, () => ({ path: "drip-picker", namespace: "unified-fixture" }))
      build.onResolve({ filter: /^next\/link$/ }, () => ({ path: "next-link", namespace: "unified-fixture" }))
      build.onLoad({ filter: /.*/, namespace: "unified-fixture" }, ({ path: key }) => ({ contents: stubs[key], loader: "jsx", resolveDir: path.resolve("node_modules") }))
    } }],
  })
  html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}\n:root{--font-geist-sans:Arial,sans-serif;--font-geist-mono:monospace}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(`${SHOTS}/preview.html`, html)
})

async function open(page: Page, search = "", width = 1280) {
  await page.setViewportSize({ width, height: 900 })
  await page.route("http://harness.local/**", (route) => route.fulfill({ contentType: "text/html", body: html }))
  await page.goto(`http://harness.local/my-leads${search}`)
  await expect(page.getByTestId("work-toolbar")).toBeVisible()
}

const rowIds = (page: Page) => page.locator("[data-lead-id]").evaluateAll((els) => els.map((el) => el.getAttribute("data-lead-id")))
const countOf = async (page: Page, testId: string) => Number((await page.getByTestId(testId).innerText()).trim())
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })

test("every tab shows its count and the matching rows", async ({ page }) => {
  await open(page)
  expect(await countOf(page, "work-tab-count-needs_attention")).toBe(60)
  expect(await countOf(page, "work-tab-count-waiting")).toBe(12)
  expect(await countOf(page, "work-tab-count-all")).toBe(74)
  expect(await rowIds(page)).toHaveLength(25)
  await shot(page, "needs-attention")
  await page.getByTestId("work-tab-waiting").click()
  await expect(page.getByTestId("work-tab-waiting")).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => rowIds(page).then((ids) => ids.length)).toBe(12)
  expect(page.url()).toContain("tab=waiting")
  await shot(page, "waiting")
  await page.getByTestId("work-tab-all").click()
  await expect.poll(() => rowIds(page).then((ids) => ids.length)).toBe(25)
  expect(await countOf(page, "work-tab-count-all")).toBe(74)
  await shot(page, "all-leads")
})

test("each Needs attention chip filters to exactly the rows its count promises", async ({ page }) => {
  await open(page)
  for (const chip of ["new_lead", "call_today", "due", "new_reply", "broken", "offer", "gone_quiet", "nothing_planned"]) {
    const count = await countOf(page, `work-chip-count-${chip}`)
    await page.getByTestId(`work-chip-${chip}`).click()
    await expect(page.getByTestId(`work-chip-${chip}`)).toHaveAttribute("aria-pressed", "true")
    await expect.poll(() => rowIds(page).then((ids) => ids.length)).toBe(Math.min(count, 25))
    const reasons = await page.locator("[data-lead-id]").evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute("data-reason")))])
    expect(reasons).toEqual([chip])
    expect(page.url()).toContain(`chip=${chip}`)
  }
  await page.getByTestId("work-chip-due").click()
  await shot(page, "chip-due")
  await page.getByTestId("work-tab-waiting").click()
  for (const chip of ["in_drip", "texted_last", "offer_out", "callback_booked"]) {
    const count = await countOf(page, `work-chip-count-${chip}`)
    await page.getByTestId(`work-chip-${chip}`).click()
    await expect.poll(() => rowIds(page).then((ids) => ids.length)).toBe(count)
  }
})

test("the stage filter and the hidden search narrow the list", async ({ page }) => {
  await open(page)
  const label = await page.getByTestId("work-stage-select").locator("option[value='not_contacted']").innerText()
  const stageCount = Number(/\((\d+)\)/.exec(label)![1])
  await page.getByTestId("work-stage-select").selectOption("not_contacted")
  await expect.poll(() => rowIds(page).then((ids) => ids.length)).toBe(stageCount)
  expect(page.url()).toContain("stage=not_contacted")
  await page.getByTestId("work-stage-select").selectOption("")
  await expect(page.getByTestId("work-search-input")).toHaveCount(0)
  await page.getByTestId("work-search-open").click()
  await page.getByTestId("work-search-input").fill("Dana")
  await expect.poll(() => page.url()).toContain("q=Dana")
  await expect.poll(async () => await page.locator("[data-lead-id]").count()).toBeGreaterThan(0)
  const rows = await page.locator("[data-lead-id]").evaluateAll((els) => els.map((el) => el.textContent ?? ""))
  expect(rows.every((text) => text.includes("Dana Whitfield"))).toBe(true)
  await shot(page, "search")
})

test("Expand all opens every row with its texts, and Collapse all closes them", async ({ page }) => {
  await open(page)
  await page.getByTestId("work-chip-new_reply").click()
  await expect.poll(() => rowIds(page).then((ids) => ids.length)).toBe(6)
  await page.getByTestId("work-toggle-all").click()
  await expect(page.locator("[data-expanded='true']")).toHaveCount(6)
  await expect(page.locator("[data-testid^='conversation-box-']")).toHaveCount(6)
  await expect(page.getByTestId("conversation-box-nr1")).toContainText("Yes, that works")
  await shot(page, "expanded")
  await page.getByTestId("work-toggle-all").click()
  await expect(page.locator("[data-expanded='true']")).toHaveCount(0)
})

test("page numbers move to page 2 and the URL carries it", async ({ page }) => {
  await open(page)
  const firstPage = await rowIds(page)
  await page.getByRole("button", { name: "Page 2" }).click()
  await expect(page.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page")
  await expect.poll(async () => (await rowIds(page))[0]).not.toBe(firstPage[0])
  expect(await rowIds(page)).toHaveLength(25)
  expect(page.url()).toContain("page=2")
  await shot(page, "page-2")
  await page.getByRole("button", { name: "Page 3" }).click()
  await expect.poll(() => rowIds(page).then((ids) => ids.length)).toBe(10)
})

test("Back and Forward restore tab, stage, page and search from the address bar", async ({ page }) => {
  await open(page)
  const step = async (label: string) => ({ label, url: new URL(page.url()), ids: await rowIds(page) })
  const params = (u: URL) => Object.fromEntries(u.searchParams)
  // Entry 1: default view. Entry 2: All leads. Entry 3: + stage. Entry 4: + page 2. Search then rewrites entry 4 (no new entry).
  const start = await step("default")
  await page.getByTestId("work-tab-all").click()
  await expect(page.getByTestId("work-tab-all")).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => page.url()).toContain("tab=all")
  const allTab = await step("all")
  await page.getByTestId("work-stage-select").selectOption("contacted")
  await expect.poll(() => page.url()).toContain("stage=contacted")
  await expect.poll(async () => (await rowIds(page)).join()).not.toBe(allTab.ids.join())
  const staged = await step("stage")
  await page.getByRole("button", { name: "Page 2" }).click()
  await expect.poll(() => page.url()).toContain("page=2")
  await expect(page.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page")
  const paged = await step("page2")
  expect(paged.ids[0]).not.toBe(staged.ids[0])
  expect(params(paged.url)).toEqual({ tab: "all", stage: "contacted", page: "2" })
  await page.getByTestId("work-search-open").click()
  await page.getByTestId("work-search-input").fill("Dana")
  await expect.poll(() => page.url()).toContain("q=Dana")
  await expect.poll(() => rowIds(page).then((ids) => ids.length)).toBeGreaterThan(0)
  expect(params(new URL(page.url()))).toEqual({ tab: "all", stage: "contacted", q: "Dana" })

  // Back from the searched entry: it was a replace, so Back skips to the stage entry (page 1, no search).
  await page.goBack()
  await expect.poll(() => page.url()).toContain("stage=contacted")
  await expect.poll(() => page.url()).not.toContain("q=")
  await expect.poll(async () => (await rowIds(page)).join()).toBe(staged.ids.join())
  expect(params(new URL(page.url()))).toEqual(params(staged.url))
  await expect(page.getByTestId("work-tab-all")).toHaveAttribute("aria-selected", "true")
  await expect(page.getByTestId("work-stage-select")).toHaveValue("contacted")

  await page.goBack()
  await expect.poll(() => page.url()).not.toContain("stage=")
  await expect.poll(async () => (await rowIds(page)).join()).toBe(allTab.ids.join())
  await expect(page.getByTestId("work-stage-select")).toHaveValue("")

  await page.goBack()
  await expect.poll(() => page.url()).not.toContain("tab=")
  await expect(page.getByTestId("work-tab-needs_attention")).toHaveAttribute("aria-selected", "true")
  await expect.poll(async () => (await rowIds(page)).join()).toBe(start.ids.join())

  // Forward replays the pushed entries.
  await page.goForward()
  await page.goForward()
  await expect.poll(() => page.url()).toContain("stage=contacted")
  await expect.poll(async () => (await rowIds(page)).join()).toBe(staged.ids.join())
})

test("a deep link pins its row at the top of the tab it belongs to, expanded", async ({ page }) => {
  await open(page, "?lead=dr3")
  await expect(page.getByTestId("work-tab-waiting")).toHaveAttribute("aria-selected", "true")
  expect((await rowIds(page))[0]).toBe("dr3")
  await expect(page.getByTestId("work-row-dr3")).toHaveAttribute("data-expanded", "true")
  expect((await rowIds(page)).filter((id) => id === "dr3")).toHaveLength(1)
  await shot(page, "deep-link")
  await page.getByTestId("work-tab-needs_attention").click()
  await expect.poll(() => page.url()).not.toContain("lead=")
  await expect.poll(() => rowIds(page).then((ids) => ids.length)).toBe(25)
})

test("a changed list shows List updated and Refresh swaps the new page in", async ({ page }) => {
  await open(page)
  const before = await rowIds(page)
  await page.evaluate(() => {
    ;(window as unknown as { __harness: { prepend: (id: string) => void } }).__harness.prepend("fresh1")
    window.dispatchEvent(new Event("focus"))
  })
  const banner = page.getByTestId("work-list-updated")
  await expect(banner).toContainText("List updated")
  expect(await rowIds(page)).toEqual(before)
  await shot(page, "list-updated")
  await banner.getByRole("button", { name: /Refresh/ }).click()
  await expect.poll(async () => (await rowIds(page))[0]).toBe("fresh1")
  await expect(banner).toHaveCount(0)
})

test("Call today pins the lead and Undo puts it back", async ({ page }) => {
  await open(page, "?chip=due")
  await page.getByTestId("work-row-toggle-du1").click()
  await page.getByTestId("work-row-call-today-du1").click()
  await expect(page.getByTestId("work-row-removed")).toContainText("Moved out of this view")
  await expect(page.getByTestId("work-row-du1")).toHaveCount(0)
  await expect(page.getByTestId("harness-log")).toContainText("pin:pin:du1")
  await page.getByTestId("work-chip-call_today").click()
  await expect(page.getByTestId("work-row-du1")).toBeVisible()
  await expect(page.getByTestId("work-row-headline-du1")).toContainText("Call today")
  await shot(page, "call-today")
  await page.getByTestId("work-row-undo-du1").first().click()
  await expect(page.getByTestId("harness-log")).toContainText("pin:clear:du1")
  await expect(page.getByTestId("work-row-removed")).toBeVisible()
})

test("the owner view is read-only except Open lead", async ({ page }) => {
  await open(page, "?view=owner")
  await page.getByTestId("work-row-toggle-nl1").click()
  const buttons = page.getByTestId("work-row-actions-nl1").getByRole("button")
  for (let i = 0; i < (await buttons.count()); i++) await expect(buttons.nth(i)).toBeDisabled()
  await expect(page.getByTestId("work-row-actions-nl1").getByRole("link", { name: "Open lead" })).toBeEnabled()
})

for (const width of [1440, 390]) {
  test(`renders without horizontal overflow at ${width}px, collapsed and expanded`, async ({ page }) => {
    await open(page, "", width)
    expect(await noOverflow(page)).toBe(true)
    await shot(page, `layout-${width}-collapsed`)
    await page.getByTestId("work-chip-broken").click()
    await expect.poll(() => rowIds(page).then((ids) => ids.length)).toBe(3)
    await page.getByTestId("work-toggle-all").click()
    await expect(page.locator("[data-expanded='true']")).toHaveCount(3)
    await expect(page.locator("[data-testid^='conversation-box-']")).toHaveCount(3)
    expect(await noOverflow(page)).toBe(true)
    await shot(page, `layout-${width}-expanded`)
  })
}
