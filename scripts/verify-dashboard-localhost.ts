import { chromium } from "@playwright/test";

const URL = process.env.VERIFY_URL ?? "http://localhost:3000";
const EMAIL = process.env.VERIFY_EMAIL ?? "claude@test.com";
const PASSWORD = process.env.VERIFY_PASSWORD ?? "test12345";

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  console.log(`→ Sign in as ${EMAIL} on ${URL}`);
  await page.goto(`${URL}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  // Visit dashboard explicitly in case post-login default differs.
  await page.goto(`${URL}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const finalUrl = page.url();
  const bodyText = await page.locator("body").innerText().catch(() => "");

  const checks = {
    on_dashboard: finalUrl.includes("/dashboard"),
    no_could_not_load: !bodyText.includes("Could not load"),
    has_overview: bodyText.includes("Overview"),
    has_skip_trace: bodyText.includes("Skip-Trace") || bodyText.includes("Skip-trace"),
    has_total_leads: bodyText.includes("Total leads") || bodyText.includes("TOTAL LEADS"),
    has_hot_leads: bodyText.includes("Hot leads") || bodyText.includes("HOT LEADS"),
    has_attention_or_clear:
      bodyText.includes("Needs Attention") ||
      bodyText.includes("NEEDS ATTENTION") ||
      bodyText.includes("All clear"),
  };

  console.log(`\nfinal URL: ${finalUrl}`);
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
  }

  await page.screenshot({ path: "/tmp/dashboard-localhost.png", fullPage: true });
  console.log("\nScreenshot: /tmp/dashboard-localhost.png");

  await browser.close();

  const allPass = Object.values(checks).every(Boolean);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
