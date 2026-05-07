/* Edit BMH Group privacy policy on Tailor Brands (Duda-based site builder)
 * via Playwright. Applies 4 TCR-required edits then republishes.
 *
 * Usage:
 *   # Discovery — headed run that logs frame structure + screenshots, stops before edits.
 *   npx tsx scripts/edit-tailor-brands-privacy.ts --discover
 *
 *   # Full run — applies the 4 edits + republishes + verifies live.
 *   npx tsx scripts/edit-tailor-brands-privacy.ts
 *
 *   # Add --headless once you trust it.
 *   npx tsx scripts/edit-tailor-brands-privacy.ts --headless
 *
 * Credentials live at /Users/jarradhenry/Sites/Sandra/.secrets/tailor-brands.env
 * (gitignored). Path is absolute so it works from any worktree.
 */
import { chromium, FrameLocator, Page, BrowserContext } from "playwright";
import fs from "node:fs";
import path from "node:path";

// -----------------------------------------------------------------------------
// Absolute paths — keep secrets pinned to the main repo, not the worktree.
// -----------------------------------------------------------------------------
const SANDRA_ROOT = "/Users/jarradhenry/Sites/Sandra";
const SECRETS_DIR = path.join(SANDRA_ROOT, ".secrets");
const ENV_PATH = path.join(SECRETS_DIR, "tailor-brands.env");
const STORAGE_STATE_PATH = path.join(SECRETS_DIR, "tailor-brands-state.json");
const ARTIFACTS_DIR = path.join(SECRETS_DIR, "tailor-brands-artifacts");
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

// -----------------------------------------------------------------------------
// Env loading (zero-dep)
// -----------------------------------------------------------------------------
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`Missing ${ENV_PATH}`);
  }
  for (const raw of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const EMAIL = process.env.TAILOR_EMAIL!;
const PASSWORD = process.env.TAILOR_PASSWORD!;
const LOGIN_URL = process.env.TAILOR_LOGIN_URL || "https://studio.tailorbrands.com/login";
const HAS_2FA = (process.env.TAILOR_2FA || "no").toLowerCase() === "yes";

if (!EMAIL || !PASSWORD) {
  throw new Error("TAILOR_EMAIL and TAILOR_PASSWORD must be set in .secrets/tailor-brands.env");
}

const args = new Set(process.argv.slice(2));
const DISCOVER = args.has("--discover");
const HEADLESS = args.has("--headless");

// -----------------------------------------------------------------------------
// Tailor Brands constants — confirmed from reconnaissance
// -----------------------------------------------------------------------------
const STUDIO = "https://studio.tailorbrands.com";
const BRAND_ID = "8891226468"; // BMH org in Tailor Brands
const SITE_LIST_URL = `${STUDIO}/brands/${BRAND_ID}/websites/list`;

// -----------------------------------------------------------------------------
// The 4 edits — TCR compliance + legal entity alignment
//   #1: TCR-required "Mobile information" verbatim phrase
//   #2: Replace [Insert contact email] placeholder
//   #3: SMS opt-in section — full TCPA disclosure + legal entity name
//   #4: Privacy policy header — entity name match
// -----------------------------------------------------------------------------
type Edit = { id: string; find: string; replace: string };
const EDITS: Edit[] = [
  {
    id: "1-mobile-information-clause",
    find: "Any information you provide through opt-in consent will not be shared with third parties for marketing or promotional purposes.",
    replace:
      "Mobile information will not be shared with third parties or affiliates for marketing or promotional purposes. All categories of consumer information identified above are subject to this restriction.",
  },
  {
    id: "2-contact-placeholder",
    find: "please contact us at [Insert contact email or other contact details].",
    replace: "please contact us at jarrad@bmhgroupkc.com or 816-280-4181.",
  },
  {
    id: "3-sms-opt-in-section",
    find:
      "By submitting the contact form and signing up for texts, you consent to receive marketing text messages from BMH Group at the number provided. Consent is not a condition of purchase. Message and data rates may apply. You can unsubscribe at any time by replying STOP to the received SMS (texts) or clicking the unsubscribe link (where available) in the marketing text messages.",
    replace:
      "By submitting the contact form and signing up for texts, you consent to receive marketing text messages from The BMH Group LLC at the number provided, including messages sent via automated technology. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe at any time. Reply HELP for assistance, or contact us at 816-280-4181.",
  },
  {
    id: "4-policy-header-entity-name",
    find: 'BMH Group ("we," "our," or "us") is committed to protecting',
    replace: 'The BMH Group LLC ("we," "our," or "us") is committed to protecting',
  },
];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
async function dumpFrames(label: string, page: Page) {
  const frames = page.frames().map((f, i) => ({ i, name: f.name(), url: f.url() }));
  const out = path.join(ARTIFACTS_DIR, `frames-${label}.json`);
  fs.writeFileSync(out, JSON.stringify(frames, null, 2));
  console.log(`[frames:${label}] ${frames.length} frame(s) → ${out}`);
  for (const f of frames) console.log(`  [${f.i}] name="${f.name}" url=${f.url}`);
}

async function snap(label: string, page: Page) {
  const out = path.join(ARTIFACTS_DIR, `${Date.now()}-${label}.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log(`[snap] ${out}`);
}

// -----------------------------------------------------------------------------
// Auth + navigation
// -----------------------------------------------------------------------------
async function login(page: Page) {
  console.log(`[login] ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testing-id="email"]').fill(EMAIL);
  await page.locator('[data-testing-id="password"]').fill(PASSWORD);
  await page.locator('[data-testing-id="login-button"]').click();

  if (HAS_2FA) {
    console.log("[login] 2FA enabled — pausing 60s for code entry in the visible browser");
    await page.waitForTimeout(60_000);
  }

  await page.waitForURL(/studio\.tailorbrands\.com\/(brands|home|users)/, { timeout: 60_000 });
  console.log(`[login] post-login URL: ${page.url()}`);
}

async function ensureBmhSelected(page: Page) {
  await page.goto(SITE_LIST_URL, { waitUntil: "domcontentloaded" });
  if (!page.url().includes(`/brands/${BRAND_ID}/`)) {
    console.log("[brand] not on BMH brand — opening Account menu to switch");
    await page.locator('[data-testing-id="header-menu-title"]').click();
    const bmhRow = page.locator(`button.org-button:has(img[src*="${BRAND_ID}"])`);
    await bmhRow.click({ timeout: 10_000 });
    await page.locator('[data-testing-id="choose-business-modal-continue-button"]').click();
    await page.waitForURL(/\/brands\/\d+\//, { timeout: 30_000 });
    if (!page.url().includes(`/brands/${BRAND_ID}/`)) {
      throw new Error(`Switch Business landed at ${page.url()} — did not select BMH (${BRAND_ID})`);
    }
    await page.goto(SITE_LIST_URL, { waitUntil: "domcontentloaded" });
  }
  // Ember SPA — wait for the actual site card to render before proceeding.
  // The card shows "bmhgroupkc.com" as the domain; that's our content anchor.
  console.log("[brand] waiting for site card to render");
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page
    .getByText(/bmhgroupkc\.com/i)
    .first()
    .waitFor({ timeout: 30_000 });
  console.log(`[brand] on BMH site list: ${page.url()}`);
}

async function openEditor(context: BrowserContext, page: Page): Promise<Page> {
  // The "Site actions" dropdown is the canonical entry to Edit site per the
  // observed UI. Try multiple selector strategies — Ember apps don't always
  // expose tidy ARIA roles.
  console.log("[editor] opening Site actions dropdown");
  const actionTriggers = [
    page.getByRole("button", { name: /site actions/i }),
    page.locator('button:has-text("Site actions")'),
    page.locator('text="Site actions"').locator("xpath=ancestor::button[1]"),
    page.locator('[data-testing-id*="site-action"]'),
  ];
  let opened = false;
  for (const t of actionTriggers) {
    const loc = t.first();
    if (await loc.isVisible({ timeout: 4000 }).catch(() => false)) {
      await loc.click();
      opened = true;
      console.log("[editor] Site actions clicked");
      break;
    }
  }
  if (!opened) {
    await snap("error-no-site-actions", page);
    throw new Error('Could not find "Site actions" button on site list page');
  }

  // Wait for the menu to render then click Edit site
  await page.waitForTimeout(500);
  const editTriggers = [
    page.getByRole("menuitem", { name: /edit site/i }),
    page.locator('text="Edit site"'),
    page.locator('button:has-text("Edit site")'),
    page.locator('a:has-text("Edit site")'),
  ];
  let trigger = editTriggers[0].first();
  let found = false;
  for (const t of editTriggers) {
    const loc = t.first();
    if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
      trigger = loc;
      found = true;
      break;
    }
  }
  if (!found) {
    await snap("error-no-edit-site", page);
    throw new Error('Could not find "Edit site" item in dropdown');
  }

  const newPagePromise = context.waitForEvent("page", { timeout: 30_000 }).catch(() => null);
  await trigger.click();
  const editorPage = (await newPagePromise) || page;
  await editorPage.bringToFront();
  await editorPage.waitForURL(/sitebuilder\.tailorbrands\.com\/home\/site\//, { timeout: 90_000 });
  await editorPage.waitForLoadState("networkidle", { timeout: 60_000 });
  await editorPage.waitForTimeout(2000);
  console.log(`[editor] loaded: ${editorPage.url()}`);
  return editorPage;
}

// -----------------------------------------------------------------------------
// Frame discovery
// -----------------------------------------------------------------------------
async function findSiteFrame(editorPage: Page): Promise<{ frame: FrameLocator; selector: string } | null> {
  const candidates = [
    'iframe[src*="cdn-website.com"]',
    'iframe[name="dm-frontend-iframe"]',
    'iframe[name*="frontend"]',
    'iframe[id*="preview"]',
    'iframe[id*="editor"]',
  ];
  for (const sel of candidates) {
    const handle = await editorPage.locator(sel).first().elementHandle().catch(() => null);
    if (handle) {
      console.log(`[frame] matched: ${sel}`);
      return { frame: editorPage.frameLocator(sel), selector: sel };
    }
  }
  console.log("[frame] no candidate iframe matched. Frames present:");
  for (const f of editorPage.frames()) console.log(`  - name="${f.name()}" url=${f.url()}`);
  return null;
}

// -----------------------------------------------------------------------------
// Edit application
// -----------------------------------------------------------------------------
async function navigateToPrivacyPage(editorPage: Page) {
  console.log("[nav] opening Pages panel");
  await editorPage.getByRole("button", { name: /^pages$/i }).first().click();
  await editorPage.waitForTimeout(1500);

  const candidates = [
    editorPage.getByText("Privacy Policy", { exact: true }),
    editorPage.getByText(/^Privacy/i),
  ];
  for (const loc of candidates) {
    if (await loc.first().isVisible().catch(() => false)) {
      await loc.first().click();
      console.log("[nav] clicked Privacy Policy");
      break;
    }
  }
  await editorPage.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await editorPage.waitForTimeout(2500);
}

async function replaceText(editorPage: Page, frame: FrameLocator, edit: Edit) {
  console.log(`\n[edit ${edit.id}] looking for: "${edit.find.slice(0, 60)}..."`);
  const anchor = edit.find.slice(0, 60);
  const target = frame.locator(`text=${anchor}`).first();

  await target.scrollIntoViewIfNeeded({ timeout: 10_000 });
  await target.click();
  await editorPage.waitForTimeout(400);
  await target.click(); // second click → contenteditable
  await editorPage.waitForTimeout(400);

  const isMac = process.platform === "darwin";
  await editorPage.keyboard.press(isMac ? "Meta+A" : "Control+A");
  await editorPage.keyboard.press("Delete");
  await editorPage.keyboard.type(edit.replace, { delay: 8 });

  await editorPage.locator("body").click({ position: { x: 5, y: 5 } });
  await editorPage.waitForTimeout(800);
  console.log(`[edit ${edit.id}] applied`);
}

async function publish(editorPage: Page) {
  console.log("\n[publish] clicking Republish/Publish");
  const pubBtn = editorPage.getByRole("button", { name: /^(republish|publish)$/i }).first();
  await pubBtn.click();

  const dialog = editorPage.getByRole("dialog");
  await dialog.waitFor({ timeout: 15_000 }).catch(() => {});
  const confirm = dialog.getByRole("button", { name: /^(republish|publish|confirm)$/i }).first();
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click();
    console.log("[publish] confirm clicked");
  }
  await editorPage
    .getByText(/published|success/i)
    .first()
    .waitFor({ timeout: 120_000 })
    .catch(() => console.log("[publish] no success toast detected — continuing"));
}

async function verifyLive(): Promise<{ ok: boolean; missing: Edit[] }> {
  console.log("\n[verify] waiting 30s for CDN propagation");
  await new Promise((r) => setTimeout(r, 30_000));
  const res = await fetch("https://bmhgroupkc.com/privacy-policy", { cache: "no-store" });
  const html = await res.text();
  const missing = EDITS.filter((e) => !html.includes(e.replace.slice(0, 60)));
  return { ok: missing.length === 0, missing };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
(async () => {
  console.log(`[start] DISCOVER=${DISCOVER} HEADLESS=${HEADLESS} 2FA=${HAS_2FA}`);
  const browser = await chromium.launch({ headless: HEADLESS });
  const useStorageState = fs.existsSync(STORAGE_STATE_PATH);
  const context = await browser.newContext(useStorageState ? { storageState: STORAGE_STATE_PATH } : {});
  const page = await context.newPage();

  try {
    await page.goto(SITE_LIST_URL, { waitUntil: "domcontentloaded" });
    if (!page.url().includes("/brands/")) {
      await login(page);
      await context.storageState({ path: STORAGE_STATE_PATH });
      console.log(`[auth] storage state saved → ${STORAGE_STATE_PATH}`);
    } else {
      console.log("[auth] reused existing session");
    }

    await ensureBmhSelected(page);
    await snap("01-site-list", page);

    const editorPage = await openEditor(context, page);
    await snap("02-editor-loaded", editorPage);
    await dumpFrames("editor-loaded", editorPage);

    const frameInfo = await findSiteFrame(editorPage);
    if (!frameInfo) {
      console.error("[abort] no site iframe found — see frames-editor-loaded.json");
      process.exit(2);
    }

    await navigateToPrivacyPage(editorPage);
    await snap("03-privacy-page", editorPage);
    await dumpFrames("privacy-page", editorPage);

    if (DISCOVER) {
      console.log("\n[discover] stopping before edits — review .secrets/tailor-brands-artifacts/");
      await editorPage.waitForTimeout(5000);
      await browser.close();
      return;
    }

    const live = await findSiteFrame(editorPage);
    if (!live) throw new Error("Privacy page iframe lost after navigation");

    for (const edit of EDITS) {
      try {
        await replaceText(editorPage, live.frame, edit);
      } catch (e) {
        console.error(`[edit ${edit.id}] FAILED:`, (e as Error).message);
        await snap(`error-${edit.id}`, editorPage);
        throw e;
      }
    }

    await snap("04-after-edits", editorPage);
    await publish(editorPage);
    await snap("05-after-publish", editorPage);

    const result = await verifyLive();
    if (result.ok) {
      console.log("\n✅ All 4 edits verified live on bmhgroupkc.com/privacy-policy");
    } else {
      console.error("\n❌ Some edits did not land on live site:");
      for (const e of result.missing) console.error(`  - ${e.id}`);
      process.exit(3);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
