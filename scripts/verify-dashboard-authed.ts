import { chromium } from "@playwright/test";

const PROD_URL = "https://sandra-sooty.vercel.app";

async function main() {
  const email = process.env.VERIFY_EMAIL ?? "claude@test.com";
  const password = process.env.VERIFY_PASSWORD ?? "test12345";

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  console.log(`→ Sign in as ${email} on ${PROD_URL}`);
  await page.goto(`${PROD_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  const url = page.url();
  const bodyText = await page.locator("body").innerText().catch(() => "");

  console.log(`\nfinal URL: ${url}`);
  console.log(`reached dashboard? ${url.includes("/dashboard")}`);
  console.log(`body has 'Could not load'? ${bodyText.includes("Could not load")}`);
  console.log(`body has 'Overview'? ${bodyText.includes("Overview")}`);
  console.log(`body has 'Skip-Trace Credits'? ${bodyText.includes("Skip-Trace Credits")}`);
  console.log(`body has 'Total leads'? ${bodyText.includes("Total leads")}`);
  console.log(`body has 'Hot leads'? ${bodyText.includes("Hot leads")}`);
  console.log(`body has 'Needs Attention'? ${bodyText.includes("Needs Attention") || bodyText.includes("All clear")}`);

  await page.screenshot({ path: "/tmp/dashboard-authed.png", fullPage: true });
  console.log("\nScreenshot: /tmp/dashboard-authed.png");

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
