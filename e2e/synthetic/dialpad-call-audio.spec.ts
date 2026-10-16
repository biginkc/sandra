import { expect, test, type Page, type Route } from "@playwright/test"
import { readFileSync } from "node:fs"
import path from "node:path"
import * as esbuild from "esbuild"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

/**
 * Database-free proof that Sandra's own copy of a Dialpad call recording plays in a real browser through the
 * lead-detail player, and that a seek after the signed link expired (a fresh one was issued ahead of it) keeps
 * playing at the new position. Chrome buffers this small file whole, so the swap to the renewed link after a media
 * error is covered by the player's RTL tests (client-playback), not here.
 * The two API routes are served by the test; the audio is a generated 20 s WAV (a real media pipeline, no binary
 * fixture). The lead-detail wiring (real detailView + panel) is covered by the RTL suite.
 */
const ORIGIN = "http://harness.test"
const STORAGE = "https://storage.example.test"
const SECONDS = 20
const RATE = 8000

let html = ""
test.beforeAll(async () => {
  const globalPath = path.resolve("src/app/globals.css")
  const css = await postcss([tailwindcss()]).process(readFileSync(globalPath, "utf8"), { from: globalPath })
  const bundle = await esbuild.build({
    entryPoints: [path.resolve("e2e/synthetic/fixtures/dialpad-call-audio-harness.tsx")],
    bundle: true, platform: "browser", format: "iife", target: "chrome120", jsx: "automatic", write: false,
    alias: {
      "@/lib/errors/report": path.resolve("e2e/synthetic/fixtures/dialpad-call-audio-stubs.ts"),
      "@": path.resolve("src"),
    },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
  })
  html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}\n:root{--font-geist-sans:Arial,sans-serif;--font-geist-mono:monospace}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0]!.text.replaceAll("</script", "<\\/script")}</script></body></html>`
})

// A 20 s, 8 kHz, 16-bit mono WAV with a tone, so Chrome's real media pipeline decodes and seeks it.
function wav(): Buffer {
  const samples = SECONDS * RATE
  const out = Buffer.alloc(44 + samples * 2)
  out.write("RIFF", 0); out.writeUInt32LE(36 + samples * 2, 4); out.write("WAVEfmt ", 8)
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(RATE, 24)
  out.writeUInt32LE(RATE * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i += 1) out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 8000), 44 + i * 2)
  return out
}

type Server = { urlRequests: number; firstExpiresAt: number; audioHits: string[] }

async function serve(page: Page, ttlMs: number): Promise<Server> {
  const body = wav()
  const server: Server = { urlRequests: 0, firstExpiresAt: 0, audioHits: [] }
  await page.route(`${ORIGIN}/`, (route) => route.fulfill({ contentType: "text/html", body: html }))
  await page.route(`${ORIGIN}/api/leads/calls/call-dialpad-1/artifacts`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ recordingStatus: "available", durationSeconds: SECONDS, transcriptStatus: "none", summaryStatus: "none", summary: null, transcript: null }) }))
  await page.route(`${ORIGIN}/api/leads/calls/call-dialpad-1/recording-url`, (route) => {
    server.urlRequests += 1
    const first = server.urlRequests === 1
    const expiresAt = first ? Date.now() + ttlMs : Date.now() + 60_000
    if (first) server.firstExpiresAt = expiresAt
    return route.fulfill({ contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify({ signedUrl: `${STORAGE}/dialpad-call-audio/${first ? "first" : `renewed-${server.urlRequests}`}.wav`, expiresAt: new Date(expiresAt).toISOString() }) })
  })
  await page.route(`${STORAGE}/dialpad-call-audio/**`, (route: Route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop()!
    server.audioHits.push(name)
    // The first signed link stops working once it has expired; renewed links keep working.
    if (name === "first.wav" && Date.now() > server.firstExpiresAt) return route.fulfill({ status: 403, body: "expired" })
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "")
    if (!range) return route.fulfill({ status: 200, contentType: "audio/wav", headers: { "accept-ranges": "bytes" }, body })
    const start = Number(range[1])
    const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1)
    return route.fulfill({ status: 206, contentType: "audio/wav", headers: { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${body.length}` }, body: body.subarray(start, end + 1) })
  })
  return server
}

const audio = (page: Page) => page.getByTestId("sandra-recording-audio")
const time = (page: Page) => audio(page).evaluate((el) => (el as HTMLAudioElement).currentTime)

test("a stored Dialpad recording loads through the signed-URL route and plays", async ({ page }) => {
  const server = await serve(page, 120_000)
  await page.goto(`${ORIGIN}/`)
  await page.getByRole("button", { name: /Load recording/ }).click()
  await expect(audio(page)).toHaveAttribute("src", /first\.wav$/)
  await expect.poll(() => audio(page).evaluate((el) => (el as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(1)
  await expect.poll(() => audio(page).evaluate((el) => Math.round((el as HTMLAudioElement).duration))).toBe(SECONDS)
  await audio(page).evaluate((el) => (el as HTMLAudioElement).play())
  await expect.poll(() => time(page), { timeout: 8_000 }).toBeGreaterThan(0.8)
  expect(server.urlRequests).toBe(1)
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("after the first signed link expired and a fresh one was issued, seeking keeps playing at the new position", async ({ page }) => {
  const server = await serve(page, 3_000)
  await page.goto(`${ORIGIN}/`)
  await page.getByRole("button", { name: /Load recording/ }).click()
  await expect(audio(page)).toHaveAttribute("src", /first\.wav$/)
  await audio(page).evaluate((el) => (el as HTMLAudioElement).play())
  await expect.poll(() => time(page), { timeout: 8_000 }).toBeGreaterThan(0.5)
  // The player asks for a fresh link ahead of expiry; wait until the first link is dead.
  await expect.poll(() => server.urlRequests, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  await expect.poll(() => Date.now() > server.firstExpiresAt).toBe(true)
  await audio(page).evaluate((el) => { (el as HTMLAudioElement).currentTime = 15 })
  await expect.poll(() => time(page), { timeout: 10_000 }).toBeGreaterThan(14.5)
  const at = await time(page)
  await expect.poll(() => time(page), { timeout: 8_000 }).toBeGreaterThan(at + 0.5)
  expect(await audio(page).evaluate((el) => (el as HTMLAudioElement).paused)).toBe(false)
  await expect(page.getByRole("alert")).toHaveCount(0)
})
