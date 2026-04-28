import { chromium } from "@playwright/test";

const PROD_URL = "https://sandra-sooty.vercel.app";

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const results: { name: string; pass: boolean; detail: string }[] = [];

  console.log("→ GET /dashboard (anonymous)");
  const dashRes = await page.goto(`${PROD_URL}/dashboard`, {
    waitUntil: "domcontentloaded",
  });
  const dashUrl = page.url();
  const dashStatus = dashRes?.status() ?? 0;
  results.push({
    name: "anonymous /dashboard redirects to /login",
    pass: dashStatus < 400 && dashUrl.includes("/login"),
    detail: `final URL=${dashUrl} status=${dashStatus}`,
  });

  console.log("→ GET /login");
  const loginRes = await page.goto(`${PROD_URL}/login`, {
    waitUntil: "domcontentloaded",
  });
  const loginStatus = loginRes?.status() ?? 0;
  const loginHasForm = await page.locator('input[type="email"], input[type="password"]').count();
  results.push({
    name: "/login renders form",
    pass: loginStatus < 400 && loginHasForm >= 2,
    detail: `status=${loginStatus} inputs=${loginHasForm}`,
  });

  console.log("→ GET /dashboard with no auth, capture body text");
  await page.goto(`${PROD_URL}/dashboard`, { waitUntil: "domcontentloaded" });
  const finalUrl = page.url();
  const bodyText = await page.locator("body").innerText();
  const containsCouldNotLoad = bodyText.includes("Could not load dashboard data");
  results.push({
    name: "no 'Could not load' on prod surface visible to anonymous",
    pass: !containsCouldNotLoad,
    detail: `final URL=${finalUrl}, contains-error=${containsCouldNotLoad}`,
  });

  await page.screenshot({ path: "/tmp/dashboard-anon.png", fullPage: true });

  await browser.close();

  console.log("\n=== Results ===");
  let allPass = true;
  for (const r of results) {
    const mark = r.pass ? "PASS" : "FAIL";
    console.log(`[${mark}] ${r.name} — ${r.detail}`);
    if (!r.pass) allPass = false;
  }
  console.log("\nScreenshot: /tmp/dashboard-anon.png");
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
