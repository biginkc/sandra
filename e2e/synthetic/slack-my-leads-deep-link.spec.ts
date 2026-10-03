import { expect, test, type Page } from "@playwright/test"
import tailwindcss from "@tailwindcss/postcss"
import * as esbuild from "esbuild"
import { readFile } from "node:fs/promises"
import path from "node:path"
import postcss from "postcss"

let compiledCss = ""
let harnessBundle = ""

const linkedLeadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const otherLeadId = "99999999-8888-4777-8666-555555555555"

test.beforeAll(async () => {
  const globalsPath = path.resolve(process.cwd(), "src/app/globals.css")
  const globalsSource = await readFile(globalsPath, "utf8")
  compiledCss = (await postcss([tailwindcss()]).process(globalsSource, { from: globalsPath })).css

  const virtualModules = new Map([
    ["next/navigation", `export const useRouter=()=>({refresh(){},push(){},replace(){}}); export const useSearchParams=()=>new URLSearchParams(window.location.search);`],
    ["next/link", `export default function Link({children, prefetch: _prefetch, ...props}) { return <a {...props}>{children}</a>; }`],
    ["rep-sms-composer", `export const RepSmsComposer=()=>null;`],
    ["notes-feed", `export const AddNoteComposer=()=>null;`],
    ["call-artifacts", `export const MyLeadCallArtifacts=()=>null;`],
    ["existing-detail-actions", `export const MyLeadAppointmentActions=()=>null; export const MyLeadCallbackActions=()=>null;`],
    ["login-background", `export const LoginBackground=()=>null;`],
    ["login-actions", `export async function signIn(){return {ok:true,data:null}} export async function signInWithHugo(){return null} export async function requestPasswordReset(){return {ok:true,data:null}}`],
  ])

  const bundle = await esbuild.build({
    entryPoints: [path.resolve(process.cwd(), "e2e/synthetic/fixtures/slack-my-leads-deep-link-harness.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    jsx: "automatic",
    jsxImportSource: "react",
    define: {
      "process.env.NODE_ENV": '"test"',
      "process.env.NEXT_PUBLIC_HUGO_SSO": '""',
    },
    write: false,
    logLevel: "silent",
    plugins: [{
      name: "slack-my-leads-browser-boundaries",
      setup(build) {
        const virtual = (key: string) => ({ path: key, namespace: "slack-my-leads-virtual" })
        build.onResolve({ filter: /^next\/navigation$/ }, () => virtual("next/navigation"))
        build.onResolve({ filter: /^next\/link$/ }, () => virtual("next/link"))
        build.onResolve({ filter: /rep-sms-composer$/ }, () => virtual("rep-sms-composer"))
        build.onResolve({ filter: /notes-feed$/ }, () => virtual("notes-feed"))
        build.onResolve({ filter: /call-artifacts$/ }, () => virtual("call-artifacts"))
        build.onResolve({ filter: /existing-detail-actions$/ }, () => virtual("existing-detail-actions"))
        build.onResolve({ filter: /login-background$/ }, () => virtual("login-background"))
        build.onResolve({ filter: /^\.\/actions$/ }, (args) => {
          return args.importer.includes(`${path.sep}(auth)${path.sep}login${path.sep}`)
            ? virtual("login-actions")
            : undefined
        })
        build.onLoad({ filter: /.*/, namespace: "slack-my-leads-virtual" }, (args) => ({
          contents: virtualModules.get(args.path) ?? "",
          loader: "tsx",
          resolveDir: process.cwd(),
        }))
      },
    }],
  })
  harnessBundle = bundle.outputFiles[0].text
})

async function installSyntheticDocument(page: Page) {
  await page.route("http://synthetic.local/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: `<style>${compiledCss}</style><div id="root"></div>`,
  }))
}

async function mount(page: Page, pathname: string, query = "") {
  await installSyntheticDocument(page)
  await page.goto(`http://synthetic.local${pathname}${query}`)
  await page.addScriptTag({ content: harnessBundle })
}

test("canonical linked lead remains visible outside the filtered page without switching owner queue", async ({ page }) => {
  await mount(page, "/my-leads", `?lead=${linkedLeadId}`)

  await expect(page.getByRole("region", { name: "Selected lead from link" })).toBeVisible()
  await expect(page.getByTestId(`my-lead-row-${linkedLeadId}-linked`)).toContainText("44 Synthetic Link Lane")
  await expect(page.getByRole("region", { name: "Text history" })).toContainText("Us:")
  await expect(page.getByRole("region", { name: "Text history" })).toContainText("Them:")

  const ownerSelect = page.getByRole("combobox", { name: "Acquisitions member" })
  await expect(ownerSelect).toHaveValue("owner-a")
  await expect(page.getByRole("heading", { name: "My Leads" }).last()).toBeVisible()

  const filter = page.getByRole("textbox", { name: "Synthetic queue filter" })
  await filter.fill("current-only")
  await expect(filter).toHaveValue("current-only")
  await expect(page.getByTestId(`my-lead-row-${linkedLeadId}-linked`)).toBeVisible()
  await expect(ownerSelect).toHaveValue("owner-a")
})

test("malformed and duplicate lead parameters are denied without selecting a lead", async ({ page }) => {
  await mount(page, "/my-leads", "?lead=not-a-uuid")
  await expect(page.getByRole("alert")).toHaveText("This My Leads link is invalid. Open a link with a valid lead id.")
  await expect(page.getByTestId(/my-lead-row-.*-linked/)).toHaveCount(0)

  await mount(page, "/my-leads", `?lead=${linkedLeadId}&lead=${otherLeadId}`)
  await expect(page.getByRole("alert")).toHaveText("This My Leads link contains more than one lead. Open a link with exactly one lead.")
  await expect(page.getByTestId(/my-lead-row-.*-linked/)).toHaveCount(0)
})

test("unavailable link retry keeps the canonical lead query and can reopen that lead", async ({ page }) => {
  await mount(page, "/my-leads", `?lead=${linkedLeadId}&state=unavailable`)

  const retry = page.getByRole("link", { name: "Retry" })
  await expect(page.getByRole("alert")).toContainText("This lead is unavailable in your My Leads queue.")
  await expect(retry).toHaveAttribute("href", `/my-leads?lead=${linkedLeadId}`)
  await expect(page.getByRole("combobox", { name: "Acquisitions member" })).toHaveValue("owner-a")

  await retry.click()
  await page.addScriptTag({ content: harnessBundle })
  await expect(page.getByRole("region", { name: "Selected lead from link" })).toBeVisible()
  await expect(page).toHaveURL(`http://synthetic.local/my-leads?lead=${linkedLeadId}`)
})

test("linked lead call uses the selected linked row and readiness save recovers from stale state", async ({ page }) => {
  await mount(page, "/my-leads", `?lead=${linkedLeadId}`)
  const linkedRow = page.getByTestId(`my-lead-row-${linkedLeadId}-linked`)

  await linkedRow.getByRole("button", { name: "Start call" }).click()
  await expect(page.getByRole("status")).toHaveText("Call request queued for 44 Synthetic Link Lane")

  await linkedRow.getByRole("button", { name: "Ready to make an offer" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.locator('label[for="acquisition-motivation-none"]').click()
  await page.getByRole("button", { name: "Save readiness" }).click()

  await expect(page.getByRole("alert")).toContainText("This lead changed. Refresh before trying again.")
  await page.getByRole("button", { name: "Refresh" }).click()
  await expect(page.getByRole("alert")).toContainText("Lead refreshed. Your draft is retained.")
  await page.getByRole("button", { name: "Save readiness" }).click()
  await expect(page.getByRole("status")).toHaveText("Saved readiness for 44 Synthetic Link Lane")
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test("real login page retains a safe My Leads lead continuation", async ({ page }) => {
  const next = `/my-leads?lead=${linkedLeadId}`
  await mount(page, "/login", `?next=${encodeURIComponent(next)}`)

  await expect(page.getByLabel("Email")).toBeVisible()
  await expect(page.locator('form input[name="next"]')).toHaveValue(next)
})
