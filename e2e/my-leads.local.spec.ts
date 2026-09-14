import { createBrowserClient } from "@supabase/ssr"
import { expect, test, type Browser, type Page } from "@playwright/test"
import fs from "node:fs"
import path from "node:path"
import pg from "pg"

import type { Database } from "../src/lib/supabase/types"

const FIXTURE_DIR = "/tmp/sandra-my-leads-acceptance-20260911"
const RUNTIME_FILE = path.join(FIXTURE_DIR, "runtime.json")
const IDENTITIES_FILE = path.join(FIXTURE_DIR, "identities.json")
const LOCAL_BASE_URL = (
  process.env.MY_LEADS_LOCAL_BASE_URL ?? "http://127.0.0.1:58700"
).replace(/\/$/, "")
const CENTRAL_TIME_ZONE = "America/Chicago"

const localAppUrl = new URL(LOCAL_BASE_URL)
if (
  localAppUrl.protocol !== "http:" ||
  localAppUrl.hostname !== "127.0.0.1" ||
  localAppUrl.port !== "58700"
) {
  throw new Error("My Leads local acceptance may target only the loopback app URL.")
}

const PROPERTY_106_ID = "20000000-0000-4000-8000-000000000006"
const PROPERTY_107_ID = "20000000-0000-4000-8000-000000000007"
const PROPERTY_102_ID = "20000000-0000-4000-8000-000000000002"
const PROPERTY_105_ID = "20000000-0000-4000-8000-000000000005"
const OWNER_ID = "10000000-0000-4000-8000-000000000002"
const REP_ID = "10000000-0000-4000-8000-000000000003"

const ADDRESS_102 = "102 My Leads Fixture Lane"
const ADDRESS_105 = "105 My Leads Fixture Lane"
const ADDRESS_106 = "106 My Leads Fixture Lane"
const ADDRESS_107 = "107 My Leads Fixture Lane"

/**
 * Fixture assumptions for the local campaign: the feature is enabled in
 * organization A, the rep owns the named properties, 102 begins Contacted
 * without a future next step, 105 begins Under Contract, 106 begins in the
 * first-call journey, and 107 begins Not contacted. The tests deliberately
 * mutate only 106 and 107 and expect 106 to leave the queue after archive and
 * 107 to leave the rep queue after handoff.
 */

type FixtureRole = "owner" | "rep" | "foreign" | "foreign-owner"
type FixtureIdentity = {
  role: FixtureRole
  id: string
  email: string
  password: string
}
type FixtureRuntime = {
  API_URL: string
  ANON_KEY: string
}

function readJson<T>(file: string): T {
  if (!file.startsWith(`${FIXTURE_DIR}/`)) {
    throw new Error("My Leads acceptance fixtures must stay under the guarded local directory.")
  }
  if (!fs.existsSync(file)) {
    throw new Error(`Missing local My Leads acceptance fixture: ${path.basename(file)}`)
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as T
}

function fixtureIdentity(role: FixtureRole): FixtureIdentity {
  const identities = readJson<FixtureIdentity[]>(IDENTITIES_FILE)
  const identity = identities.find((candidate) => candidate.role === role)
  if (!identity) throw new Error(`Missing local My Leads identity for ${role}.`)
  return identity
}

function fixtureRuntime(): FixtureRuntime {
  const runtime = readJson<FixtureRuntime>(RUNTIME_FILE)
  const runtimeUrl = runtime.API_URL ? new URL(runtime.API_URL) : null
  if (
    !runtimeUrl ||
    runtimeUrl.protocol !== "http:" ||
    runtimeUrl.hostname !== "127.0.0.1" ||
    runtimeUrl.port !== "58321" ||
    !runtime.ANON_KEY
  ) {
    throw new Error("The local My Leads runtime is missing its auth endpoint or anonymous key.")
  }
  return runtime
}

/**
 * Match e2e/auth.setup.ts: use Supabase password auth only to mint the SSR
 * cookies, without running its login assertions, provisioning, or global
 * setup. The identity/password values never enter test output or artifacts.
 */
async function signInWithFixture(page: Page, role: FixtureRole) {
  const runtime = fixtureRuntime()
  const identity = fixtureIdentity(role)
  const cookieJar = new Map<string, string>()
  const auth = createBrowserClient<Database>(runtime.API_URL, runtime.ANON_KEY, {
    isSingleton: false,
    cookies: {
      getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const cookie of cookies) {
          if (cookie.value) cookieJar.set(cookie.name, cookie.value)
          else cookieJar.delete(cookie.name)
        }
      },
    },
  })
  const { error } = await auth.auth.signInWithPassword({
    email: identity.email,
    password: identity.password,
  })
  if (error) throw new Error("Local My Leads fixture authentication failed.")

  await page.context().addCookies(
    [...cookieJar].map(([name, value]) => ({
      name,
      value,
      url: LOCAL_BASE_URL,
      sameSite: "Lax" as const,
    })),
  )
}

async function openMyLeads(page: Page, role: FixtureRole) {
  await signInWithFixture(page, role)
  await page.goto("/my-leads")
  await expect(page).toHaveURL(/\/my-leads\/?$/)
  await expect(page.getByRole("heading", { name: "My Leads" })).toBeVisible()
}

function centralWallTime(offsetMinutes: number): string {
  const target = new Date(Date.now() + offsetMinutes * 60_000)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CENTRAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(target)
    .reduce<Record<string, string>>((values, part) => {
      if (part.type !== "literal") values[part.type] = part.value
      return values
    }, {})
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

function centralMonthDay(offsetDays: number): string {
  const target = new Date(Date.now() + offsetDays * 24 * 60 * 60_000)
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CENTRAL_TIME_ZONE,
    month: "long",
    day: "numeric",
  }).format(target)
}

function rowFor(page: Page, propertyId: string) {
  return page.locator(`[data-testid="my-lead-row-${propertyId}"]`)
}

async function newFixturePage(browser: Browser) {
  const context = await browser.newContext({
    baseURL: LOCAL_BASE_URL,
    viewport: { width: 1440, height: 900 },
    timezoneId: CENTRAL_TIME_ZONE,
  })
  return { context, page: await context.newPage() }
}

async function chooseFutureAppointmentDate(page: Page) {
  const calendar = page.getByTestId("book-appointment-calendar")
  const monthDay = centralMonthDay(2)
  let day = calendar.getByRole("button", { name: new RegExp(monthDay) })
  if (await day.count() === 0) {
    await calendar.getByRole("button", { name: /next month/i }).click()
    day = calendar.getByRole("button", { name: new RegExp(monthDay) })
  }
  await expect(day).toBeVisible()
  await day.click()
}

test.describe.serial("My Leads local acceptance", () => {
  test("member sees only their queue and the shell remains usable at narrow width", async ({ page }) => {
    await openMyLeads(page, "rep")

    await expect(page.getByRole("link", { name: "My Leads" })).toBeVisible()
    await expect(page.getByText(ADDRESS_106, { exact: true })).toBeVisible()
    await expect(page.getByText(ADDRESS_107, { exact: true })).toBeVisible()
    await expect(page.locator("#my-leads-rep")).toHaveCount(0)
    await expect(page.getByText("Manage Acquisitions", { exact: true })).toHaveCount(0)

    await page.screenshot({ path: path.join(FIXTURE_DIR, "my-leads-desktop.png"), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole("heading", { name: "My Leads" })).toBeVisible()
    await expect(page.getByRole("link", { name: "My Leads" })).toBeVisible()
    const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }))
    expect(layout.width).toBeLessThanOrEqual(layout.viewport)
    await page.screenshot({ path: path.join(FIXTURE_DIR, "my-leads-narrow.png"), fullPage: true })
  })

  test("owner can inspect the selected rep while foreign organization access is denied", async ({ browser }) => {
    const { context: ownerContext, page: ownerPage } = await newFixturePage(browser)
    try {
      await openMyLeads(ownerPage, "owner")
      await expect(ownerPage.getByText("Manage Acquisitions", { exact: true })).toBeVisible()
      const repOptionIds = await ownerPage.locator("#my-leads-rep option").evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      )
      expect(repOptionIds).toContain(REP_ID)
      await ownerPage.locator("#my-leads-rep").selectOption(REP_ID)
      await expect(ownerPage.locator("#my-leads-rep")).toHaveValue(REP_ID)
      await expect(ownerPage.getByText(ADDRESS_106, { exact: true })).toBeVisible()
      const ownerKpis = await ownerPage.locator('[data-testid^="kpi-"]').allTextContents()
      const { context: repContext, page: repPage } = await newFixturePage(browser)
      try {
        await openMyLeads(repPage, "rep")
        await expect(repPage.locator('[data-testid^="kpi-"]')).toHaveCount(9)
        expect(await repPage.locator('[data-testid^="kpi-"]').allTextContents()).toEqual(ownerKpis)
      } finally {
        await repContext.close()
      }
    } finally {
      await ownerContext.close()
    }

    for (const role of ["foreign", "foreign-owner"] as const) {
      const { context: foreignContext, page: foreignPage } = await newFixturePage(browser)
      try {
        await signInWithFixture(foreignPage, role)
        await foreignPage.goto("/my-leads")
        await expect(foreignPage).toHaveURL(/\/login(?:\?|$)/)
      } finally {
        await foreignContext.close()
      }
    }
  })

  test("owner can disable and restore the rep Acquisitions designation", async ({ page }) => {
    await openMyLeads(page, "owner")
    await page.getByText("Manage Acquisitions", { exact: true }).click()

    const repDesignation = page
      .locator("details label")
      .filter({ hasText: "My Leads rep fixture" })
      .locator('input[type="checkbox"]')
    await expect(repDesignation).toHaveCount(1)
    await expect(repDesignation).toBeChecked()

    await repDesignation.click()
    await expect(repDesignation).not.toBeChecked()
    await repDesignation.click()
    await expect(repDesignation).toBeChecked()
  })

  test("keyboard can open and cancel an attempt while a contacted warning is visible", async ({ page }) => {
    await openMyLeads(page, "rep")
    const row = rowFor(page, PROPERTY_102_ID)
    await expect(row).toContainText(ADDRESS_102)
    await row.getByRole("button", { name: `Show details for ${ADDRESS_102}` }).press("Enter")
    await expect(row.locator('[aria-current="step"]')).toHaveText("Contacted")
    await expect(row.getByText("No future next step", { exact: true })).toBeVisible()

    const logAttempt = row.getByRole("button", { name: "Log attempt" })
    await logAttempt.focus()
    await logAttempt.press("Enter")
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(row.getByText("No future next step", { exact: true })).toBeVisible()
  })

  test("today metrics remain independent of lead search and historical leads remain available", async ({ page }) => {
    await openMyLeads(page, "rep")
    await expect(rowFor(page, PROPERTY_105_ID)).toContainText(ADDRESS_105)
    await expect(page.getByRole("combobox", { name: "KPI period" })).toHaveCount(0)
    const stableMetrics = page.locator('[data-testid^="kpi-"]:not([data-testid="kpi-last-attempt"])')
    const before = await stableMetrics.allTextContents()
    await page.getByRole("textbox", { name: "Search My Leads" }).fill(ADDRESS_105)
    await expect(rowFor(page, PROPERTY_105_ID)).toBeVisible()
    await expect.poll(() => stableMetrics.allTextContents()).toEqual(before)
    await expect(page.locator('[data-testid^="kpi-"]')).toHaveCount(9)
  })

  test("offer warnings reflect server deadlines and display red indicators", async ({ page }) => {
    // Only the dedicated local synthetic fixtures; save and restore both dates.
    const db = new pg.Client({ host: "127.0.0.1", port: 58322, user: "postgres", password: "postgres", database: "postgres" })
    await db.connect()
    const offerLead = "20000000-0000-4000-8000-000000000003"
    const sentLead = "20000000-0000-4000-8000-000000000004"
    const entered = (await db.query("select stage_entered_at from acquisition_queue_states where property_id=$1", [offerLead])).rows[0].stage_entered_at
    const original = (await db.query("select id,sent_at,follow_up_at from acquisition_offers where property_id=$1", [sentLead])).rows[0]
    try {
      await db.query("update acquisition_queue_states set stage_entered_at=now()-interval '11 hours' where property_id=$1", [offerLead])
      await db.query("update acquisition_offers set sent_at=now()-interval '2 hours',follow_up_at=now()+interval '1 hour' where id=$1", [original.id])
      await openMyLeads(page, "rep")
      const needsOffer = rowFor(page, offerLead)
      const offerSent = rowFor(page, sentLead)
      await expect(needsOffer.getByText("Offer overdue", { exact: true })).toHaveCount(0)
      await expect(offerSent.getByText("Offer follow-up overdue", { exact: true })).toHaveCount(0)
      await db.query("update acquisition_queue_states set stage_entered_at=now()-interval '13 hours' where property_id=$1", [offerLead])
      await db.query("update acquisition_offers set follow_up_at=now()-interval '1 hour' where id=$1", [original.id])
      await page.reload()
      await expect(needsOffer.getByText("Offer overdue", { exact: true })).toBeVisible()
      await expect(offerSent.getByText("Offer follow-up overdue", { exact: true })).toBeVisible()
      await expect(needsOffer.getByText("Offer overdue", { exact: true }).locator("..")).toHaveClass(/text-red-700/)
      await expect(offerSent.getByText("Offer follow-up overdue", { exact: true }).locator("..")).toHaveClass(/text-red-700/)
    } finally {
      await db.query("update acquisition_queue_states set stage_entered_at=$2 where property_id=$1", [offerLead, entered])
      await db.query("update acquisition_offers set sent_at=$2,follow_up_at=$3 where id=$1", [original.id, original.sent_at, original.follow_up_at])
      await db.end()
    }
  })

  test("rep records an attempt, motivation, offer, contract, and archive for 106", async ({ page }) => {
    await openMyLeads(page, "rep")
    const row = rowFor(page, PROPERTY_106_ID)
    await expect(row).toContainText(ADDRESS_106)
    await row.getByRole("button", { name: `Show details for ${ADDRESS_106}` }).click()

    await row.getByRole("button", { name: "Log attempt" }).click()
    const attemptDialog = page.getByRole("dialog")
    await expect(attemptDialog).toContainText("Log an attempt")
    await page.getByLabel("External outcome").selectOption("reached")
    await page.getByLabel("When did the outreach occur?").fill(centralWallTime(-30))
    await page.getByRole("button", { name: "Save attempt" }).click()
    await expect(page.getByRole("button", { name: "Save attempt" })).toHaveCount(0)
    await expect(row.locator('[aria-current="step"]')).toHaveText("Contacted")

    await row.getByRole("button", { name: "Ready to make an offer" }).click()
    const readinessDialog = page.getByRole("dialog")
    await expect(readinessDialog).toContainText("Ready to make an offer")
    await page.getByRole("button", { name: "Save readiness" }).click()
    await expect(readinessDialog.getByRole("alert")).toContainText("Review the highlighted fields.")
    await expect(readinessDialog.getByText("Specify the motivation or choose No motivation provided.", { exact: true })).toBeVisible()
    await page.getByLabel("Motivation", { exact: true }).fill("Seller is relocating and wants a simple sale.")
    await page.getByRole("button", { name: "Save readiness" }).click()
    await expect(page.getByRole("button", { name: "Save readiness" })).toHaveCount(0)
    await expect(row.locator('[aria-current="step"]')).toHaveText("Needs offer / Interested")

    await row.getByRole("button", { name: "Log offer" }).click()
    const offerDialog = page.getByRole("dialog")
    await expect(offerDialog).toContainText("Log offer")
    await page.getByLabel("Offer amount").fill("185000")
    await page.getByLabel("Offer method").selectOption("verbal")
    await offerDialog.getByLabel("Offer sent", { exact: true }).fill(centralWallTime(-15))
    await page.getByLabel("Required follow-up").fill(centralWallTime(60))
    await page.getByRole("button", { name: "Save offer" }).click()
    await expect(page.getByRole("button", { name: "Save offer" })).toHaveCount(0)
    await expect(row.locator('[aria-current="step"]')).toHaveText("Offer Sent")

    await row.getByRole("button", { name: "Contract signed" }).click()
    const contractDialog = page.getByRole("dialog")
    await expect(contractDialog).toContainText("Record contract signed")
    await page.getByLabel("Signed at").fill(centralWallTime(-5))
    await page.getByRole("button", { name: "Record contract" }).click()
    await expect(page.getByRole("button", { name: "Record contract" })).toHaveCount(0)
    await expect(row.locator("xpath=ancestor::section[@data-testid='my-leads-section-under_contract']")).toBeVisible()

    await row.getByRole("button", { name: "Archive" }).click()
    const archiveDialog = page.getByRole("dialog")
    await expect(archiveDialog).toContainText("Archive Under Contract lead")
    await page.getByRole("checkbox", { name: /archives the queue entry/i }).check()
    await page.getByRole("button", { name: "Archive lead" }).click()
    await expect(row).toHaveCount(0)
  })

  test("rep adds a note, deliberately books a next step, then hands off 107", async ({ page }) => {
    await openMyLeads(page, "rep")
    const row = rowFor(page, PROPERTY_107_ID)
    await expect(row).toContainText(ADDRESS_107)
    await row.getByRole("button", { name: `Show details for ${ADDRESS_107}` }).click()

    await row.getByRole("button", { name: "Log attempt" }).click()
    const attemptDialog = page.getByRole("dialog")
    await expect(attemptDialog).toContainText("Log an attempt")
    await page.getByLabel("External outcome").selectOption("no_answer")
    await page.getByLabel("When did the outreach occur?").fill(centralWallTime(-20))
    await page.getByRole("button", { name: "Save attempt" }).click()
    await expect(page.getByRole("button", { name: "Save attempt" })).toHaveCount(0)
    await expect(row.locator('[aria-current="step"]')).toHaveText("Contacted")

    const details = page.getByRole("region", { name: "Lead details" })
    await expect(details).toBeVisible()
    await details.getByText("+ Add note", { exact: true }).click()
    const note = `Local acceptance note ${Date.now()}`
    await details.getByLabel("Add a note").fill(note)
    await details.getByRole("button", { name: "Add" }).click()
    await expect(details).toContainText(note)

    await row.getByRole("button", { name: "Schedule next step" }).click()
    await page.getByRole("button", { name: "Book appt" }).click()
    await expect(page.getByTestId("book-appointment-popover")).toBeVisible()
    await chooseFutureAppointmentDate(page)
    await page.getByTestId("book-appointment-time").click()
    await page.getByRole("option", { name: "10:00 AM", exact: true }).click()
    await expect(page.getByTestId("book-appointment-timezone-label")).toContainText(CENTRAL_TIME_ZONE)
    await expect(page.getByTestId("book-appointment-submit")).toBeEnabled()
    await page.getByTestId("book-appointment-submit").click()
    await expect(page.getByTestId("book-appointment-popover")).toHaveCount(0)
    await expect(row.getByText("No future next step", { exact: true })).toHaveCount(0)

    await row.getByRole("button", { name: "Handoff" }).click()
    const handoffDialog = page.getByRole("dialog")
    await expect(handoffDialog).toContainText("Hand off lead")
    await page.getByLabel("Handoff reason").selectOption("not_interested")
    await page.getByLabel("Reassign to").selectOption(OWNER_ID)
    await page.getByRole("button", { name: "Hand off lead" }).click()
    await expect(row).toHaveCount(0)
  })
})
