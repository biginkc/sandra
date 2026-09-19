import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const origin = "http://127.0.0.1:58790";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const checks = [];
const scopes = new Set();
const errors = [];
const shapeResponses = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => {
  if (new URL(r.url()).pathname.startsWith("/sync/shape/"))
    shapeResponses.push({
      path: new URL(r.url()).pathname,
      status: r.status(),
    });
});
page.on("response", async (response) => {
  if (
    response.url() === origin + "/sync/worksets" &&
    response.status() === 201
  ) {
    try {
      scopes.add((await response.json()).id);
    } catch {}
  }
});
async function cleanup() {
  for (const id of scopes) {
    await page.request.delete(`${origin}/sync/worksets/${id}`, {
      headers: { authorization: "Bearer synthetic-a" },
    });
  }
  scopes.clear();
}
async function ready() {
  await page
    .getByText("100 synchronized rows", { exact: true })
    .waitFor({ timeout: 20000 });
}
async function selectAndInspect() {
  const row = page.locator("[data-row-id]").first();
  await row.locator(".preview").click();
  await row.getByRole("button", { name: "Open", exact: true }).click();
  assert.equal(
    await page.getByTestId("selection-count").innerText(),
    "1 selected",
  );
  assert.equal(await page.locator("[data-open=true]").count(), 1);
}
async function mockReceipt() {
  await page.route("**/bulk/operations", (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ operationId: "fixture-auth-cleanup-receipt" }),
    }),
  );
  await page.route("**/bulk/operations/fixture-auth-cleanup-receipt", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: "completed",
        receipts: [
          {
            property_id: "fixture-property",
            step: "outcome",
            state: "completed",
          },
        ],
      }),
    }),
  );
  await page
    .getByRole("button", { name: "Outcome + assign 1", exact: true })
    .click();
  await page
    .getByTestId("operation")
    .getByText("outcome: completed", { exact: true })
    .waitFor();
}
async function deniedRenewal(status) {
  await page.route("**/sync/worksets", (route) => {
    if (route.request().method() === "POST")
      return route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ error: "synthetic renewal denial" }),
      });
    return route.continue();
  });
  const renewal = page.waitForResponse(
    (r) =>
      r.url() === origin + "/sync/worksets" &&
      r.request().method() === "POST" &&
      r.status() === status,
    { timeout: 55000 },
  );
  await renewal;
  await page
    .getByRole("alert")
    .filter({ hasText: "Access denied" })
    .waitFor({ timeout: 10000 });
  assert.equal(await page.locator("[data-row-id]").count(), 0);
  assert.equal(await page.getByTestId("selection-count").count(), 0);
  assert.equal(await page.locator("[data-open=true]").count(), 0);
  assert.equal(await page.getByTestId("operation").count(), 0);
  assert.equal(
    await page
      .getByRole("heading", { name: "Conversation inspection" })
      .count(),
    0,
  );
  checks.push({
    name: `renewal POST${status} removes visible rows, selection, inspection and populated receipt UI`,
    passed: true,
  });
  await page.unroute("**/sync/worksets");
}
try {
  // Hold one old live fetch at the browser transport layer. Its result is intentionally
  // delivered after replacement even when cleanup aborts that old request's signal.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.__lateShape = {
      armed: sessionStorage.getItem("disableLateShape") !== "1",
      held: false,
      released: false,
      returned: false,
      oldPath: null,
    };
    window.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        location.href,
      );
      const test = window.__lateShape;
      if (
        test.armed &&
        !test.held &&
        url.pathname.startsWith("/sync/shape/") &&
        url.searchParams.get("live") === "true"
      ) {
        test.held = true;
        test.oldPath = url.pathname;
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            if (test.released) {
              clearInterval(timer);
              resolve();
            }
          }, 25);
        });
        test.returned = true;
        return new Response(
          JSON.stringify({ error: "delayed old shape denial" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      return original(input, init);
    };
  });
  await page.goto(origin);
  await ready();
  await selectAndInspect();
  await page.waitForFunction(() => window.__lateShape.held, { timeout: 10000 });
  const beforeSelected = await page
    .locator("[data-selected=true]")
    .getAttribute("data-row-id");
  const replacement = await page.waitForResponse(
    (r) =>
      r.url() === origin + "/sync/worksets" &&
      r.request().method() === "POST" &&
      r.status() === 201,
    { timeout: 55000 },
  );
  const next = await replacement.json();
  await ready();
  for (
    let n = 0;
    n < 60 &&
    !shapeResponses.some(
      (r) => r.path === `/sync/shape/${next.id}` && r.status === 200,
    );
    n++
  )
    await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(
    shapeResponses.some(
      (r) => r.path === `/sync/shape/${next.id}` && r.status === 200,
    ),
    "replacement snapshot reached actual browser",
  );
  await page.evaluate(() => {
    window.__lateShape.released = true;
  });
  await page.waitForFunction(() => window.__lateShape.returned);
  // Two rendering turns let the rejected old fetch propagate without requiring a new DB mutation.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await page.locator("[data-selected=true]").getAttribute("data-row-id"),
    beforeSelected,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Outcome + assign 1", exact: true })
      .isEnabled(),
    true,
  );
  assert.equal(await page.getByRole("alert").count(), 0);
  checks.push({
    name: "late old-shape403 after real renewal leaves replacement live, selected and actionable",
    passed: true,
  });
  await mockReceipt();
  await deniedRenewal(401);
  await cleanup();
  await page.evaluate(() => sessionStorage.setItem("disableLateShape", "1"));
  await page.goto(origin);
  await ready();
  await selectAndInspect();
  await mockReceipt();
  await deniedRenewal(403);
  await cleanup();
  assert.deepEqual(errors, []);
  checks.push({ name: "no uncaught browser exceptions", passed: true });
  const evidence = {
    at: new Date().toISOString(),
    passed: checks.length,
    checks,
    renewalTimerMs: 45000,
    limits: [
      "Synthetic local browser only; no membership or canonical database mutations",
      "Receipt content is intercepted fixture data; no internal cache introspection",
      "Late403 is returned by injected fetch after replacement; SDK may discard it on cleanup before onError, so this proves observable resilience, not stale callback branch execution",
      "No production auth or load certification",
    ],
  };
  await writeFile(
    "browser/auth-evidence.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(0, 1500));
  throw error;
} finally {
  await cleanup();
  await browser.close();
}
