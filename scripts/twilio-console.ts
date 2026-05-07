/* Step-driven Playwright automation for Twilio Console A2P 10DLC setup.
 *
 * Usage (run from worktree root):
 *   npx tsx scripts/twilio-console.ts login              # one-time: you log in + 2FA
 *   npx tsx scripts/twilio-console.ts submit-profile     # open BMH profile, you click Submit
 *   npx tsx scripts/twilio-console.ts buy-number         # filter 816, you pick + click Buy
 *   npx tsx scripts/twilio-console.ts register-brand     # auto-fill brand wizard
 *   npx tsx scripts/twilio-console.ts register-campaign  # auto-fill campaign wizard
 *
 * Storage state is persisted at /Users/jarradhenry/Sites/Sandra/.secrets/twilio-state.json
 * (gitignored). No credentials are ever stored — only session cookies after login.
 *
 * Screenshots land in /Users/jarradhenry/Sites/Sandra/.secrets/twilio-artifacts/
 */
import { chromium, BrowserContext, Page } from "playwright";
import fs from "node:fs";
import path from "node:path";

const SANDRA_ROOT = "/Users/jarradhenry/Sites/Sandra";
const SECRETS_DIR = path.join(SANDRA_ROOT, ".secrets");
const STORAGE_STATE_PATH = path.join(SECRETS_DIR, "twilio-state.json");
const ARTIFACTS_DIR = path.join(SECRETS_DIR, "twilio-artifacts");
fs.mkdirSync(SECRETS_DIR, { recursive: true });
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const step = process.argv[2];
const flags = new Set(process.argv.slice(3));
const HEADLESS = flags.has("--headless");
const timeoutArg = process.argv.find((a) => a.startsWith("--timeout="));
const STEP_TIMEOUT_MS = Number(timeoutArg?.split("=")[1] ?? "600000"); // 10min default

const STEPS = ["login", "submit-profile", "buy-number", "register-brand", "register-campaign"] as const;
type Step = (typeof STEPS)[number];

if (!STEPS.includes(step as Step)) {
  console.error(`Usage: npx tsx scripts/twilio-console.ts <step> [--headless] [--timeout=ms]`);
  console.error(`Steps: ${STEPS.join(", ")}`);
  process.exit(1);
}

const ts = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

async function snap(page: Page, label: string): Promise<string> {
  const file = path.join(ARTIFACTS_DIR, `${ts()}_${step}_${label}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    console.log(`📸 ${file}`);
  } catch (e) {
    console.log(`⚠️  screenshot failed (${label}): ${(e as Error).message}`);
  }
  return file;
}

async function waitForUrlMatch(page: Page, regex: RegExp, timeoutMs: number, label = "url"): Promise<boolean> {
  const start = Date.now();
  let lastUrl = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const url = page.url();
      if (url !== lastUrl) {
        console.log(`   url=${url}`);
        lastUrl = url;
      }
      if (regex.test(url)) return true;
    } catch {
      /* page closed — keep polling */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  try { console.log(`⚠️  ${label} timeout. Final url=${page.url()}`); } catch {}
  return false;
}

/** Poll EVERY page in the context (handles SSO popups + redirects after the original tab closes). */
async function waitForAnyPageUrl(ctx: BrowserContext, regex: RegExp, timeoutMs: number): Promise<Page | null> {
  const start = Date.now();
  const seen = new Set<string>();
  while (Date.now() - start < timeoutMs) {
    for (const p of ctx.pages()) {
      let url = "";
      try { url = p.url(); } catch { continue; }
      if (!seen.has(url)) {
        console.log(`   page=${url}`);
        seen.add(url);
      }
      if (regex.test(url)) return p;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

// ---------------------------------------------------------------------------
// STEP: login
// ---------------------------------------------------------------------------
async function login(ctx: BrowserContext, page: Page) {
  console.log("Opening Twilio login...");
  await page.goto("https://www.twilio.com/login", { waitUntil: "domcontentloaded" });
  console.log("");
  console.log("👤 Browser is open. In the window:");
  console.log("   1. Enter email + password");
  console.log("   2. Complete 2FA");
  console.log("   3. Wait until you land on the Twilio Console (anything under console.twilio.com/us1/...)");
  console.log("");
  console.log(`Polling for post-login URL (up to ${STEP_TIMEOUT_MS / 1000}s)...`);
  const ok = await waitForUrlMatch(page, /console\.twilio\.com\/us1\//, STEP_TIMEOUT_MS, "post-login");
  if (!ok) throw new Error("Login timeout — did you finish 2FA?");
  console.log("✅ Detected post-login URL");
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await snap(page, "logged-in");
  await ctx.storageState({ path: STORAGE_STATE_PATH });
  console.log(`💾 Saved storage state to ${STORAGE_STATE_PATH}`);
  console.log("");
  console.log("✅ Login complete. Next: npx tsx scripts/twilio-console.ts submit-profile");
}

// ---------------------------------------------------------------------------
// STEP: submit-profile
//   Open the BMH customer profile, screenshot it, wait for the user to click
//   "Submit for review", then screenshot the result.
// ---------------------------------------------------------------------------
async function submitProfile(ctx: BrowserContext, page: Page) {
  const URL = "https://console.twilio.com/us1/account/trust-hub/customer-profiles";
  console.log(`Navigating to ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await snap(page, "profile-list");

  console.log("");
  console.log("👇 In the browser window:");
  console.log("   1. Click into the BMH customer profile row");
  console.log("   2. Scroll down to find 'Submit for review' (or similar wording)");
  console.log("   3. Click it");
  console.log("");
  console.log(`Polling for state change (up to ${STEP_TIMEOUT_MS / 1000}s)...`);
  console.log("(I'll screenshot every 30s so you can see I'm watching.)");

  // Poll for a "submitted" or "in review" or "pending" indicator on the page.
  const start = Date.now();
  let lastSnapAt = 0;
  const SUCCESS_TEXTS = ["pending review", "in review", "in-review", "submitted", "under review"];
  while (Date.now() - start < STEP_TIMEOUT_MS) {
    const html = await page.content().catch(() => "");
    const lower = html.toLowerCase();
    if (SUCCESS_TEXTS.some((t) => lower.includes(t))) {
      console.log("✅ Detected review/submitted state on page");
      await snap(page, "post-submit");
      console.log("");
      console.log("Done. Next: npx tsx scripts/twilio-console.ts buy-number");
      return;
    }
    if (Date.now() - lastSnapAt > 30000) {
      await snap(page, `polling-${Math.floor((Date.now() - start) / 1000)}s`);
      lastSnapAt = Date.now();
    }
    await page.waitForTimeout(2000);
  }
  await snap(page, "timeout");
  throw new Error("submit-profile timeout — no review/submitted state detected. Check screenshots.");
}

// ---------------------------------------------------------------------------
// Stubs — implement after submit-profile is verified working
// ---------------------------------------------------------------------------
async function buyNumber(_ctx: BrowserContext, page: Page) {
  await page.goto("https://console.twilio.com/us1/develop/phone-numbers/manage/search");
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await snap(page, "search-page");
  throw new Error("buy-number not implemented yet — screenshot taken for DOM discovery.");
}

async function registerBrand(_ctx: BrowserContext, page: Page) {
  await page.goto("https://console.twilio.com/us1/develop/sms/regulatory-compliance/a2p-onboarding");
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await snap(page, "onboarding");
  throw new Error("register-brand not implemented yet — screenshot taken for DOM discovery.");
}

async function registerCampaign(_ctx: BrowserContext, page: Page) {
  await page.goto("https://console.twilio.com/us1/develop/sms/regulatory-compliance/a2p-onboarding");
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await snap(page, "onboarding");
  throw new Error("register-campaign not implemented yet — screenshot taken for DOM discovery.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const useState = step !== "login" && fs.existsSync(STORAGE_STATE_PATH);
  if (step !== "login" && !useState) {
    console.error(`No storage state at ${STORAGE_STATE_PATH}. Run 'login' step first.`);
    process.exit(1);
  }
  console.log(`Step: ${step}  Headless: ${HEADLESS}  StorageState: ${useState ? "loaded" : "(none)"}`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({
    storageState: useState ? STORAGE_STATE_PATH : undefined,
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  try {
    if (step === "login") await login(ctx, page);
    else if (step === "submit-profile") await submitProfile(ctx, page);
    else if (step === "buy-number") await buyNumber(ctx, page);
    else if (step === "register-brand") await registerBrand(ctx, page);
    else if (step === "register-campaign") await registerCampaign(ctx, page);
  } finally {
    // For login: keep state already saved above. For other steps: don't overwrite.
    await browser.close();
  }
})().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
