import { chromium } from "playwright";
import pg from "pg";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
const db = new pg.Pool({
  connectionString: "postgres://postgres@127.0.0.1:58782/sandra_inbox_t1",
});
assert.equal(
  (await db.query("select current_database() as name")).rows[0].name,
  "sandra_inbox_t1",
);
assert.equal(
  (await db.query("select marker from inbox_t1.fixture_identity")).rows[0]
    .marker,
  "sandra-inbox-stack-t1-owned-synthetic",
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const checks = [];
const operations = [];
const worksetIds = [];
page.on("response", (r) => {
  if (r.url().endsWith("/sync/worksets") && r.status() === 201)
    void r.json().then((w) => worksetIds.push(w.id));
});
const check = (name) => checks.push({ name, passed: true });
const count = async (n) => {
  await page.waitForFunction(
    (n) =>
      document.querySelector('[data-testid="selection-count"]')?.textContent ===
      `${n} selected`,
    n,
  );
};
const row = (n) => {
  const h = createHash("md5")
    .update(`inbox-t1-conversation-${n}`)
    .digest("hex");
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return page.locator(`[data-row-id="${id}"]`);
};
const click = async (n, shift = false) => {
  await row(n)
    .locator(".preview")
    .click({ modifiers: shift ? ["Shift"] : [] });
};
const completed = async () => {
  await page
    .getByTestId("operation")
    .getByText("completed", { exact: true })
    .waitFor({ timeout: 20000 });
};
try {
  await page.goto("http://127.0.0.1:58790/");
  await row(4).waitFor();
  await click(4);
  await count(1);
  assert.equal(await page.locator("[data-open=true]").count(), 0);
  await click(6, true);
  await count(2);
  await click(4, true);
  await count(1);
  check("single click and Shift-click toggle without opening");
  await row(8).getByRole("button", { name: "Open", exact: true }).click();
  await count(1);
  assert.equal(await row(8).getAttribute("data-open"), "true");
  check("explicit Open preserves selected group");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  const start = await row(4).locator(".preview").boundingBox(),
    end = await row(6).locator(".preview").boundingBox();
  await page.keyboard.down("Shift");
  await page.mouse.move(start.x + 5, start.y + 5);
  await page.mouse.down();
  await page.mouse.move(end.x + 60, end.y + 15, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await count(3);
  await click(5, true);
  await count(2);
  check(
    "Shift-drag rectangle immediately selects rows; Shift-click removes an exception",
  );
  const baselineIds = await page
    .locator("[data-selected=true]")
    .evaluateAll((es) => es.map((e) => e.dataset.rowId));
  const before = (
    await db.query(
      "select count(*)::int as n from inbox_t1.property_write_audit",
    )
  ).rows[0].n;
  const accepted = page.waitForResponse(
    (r) =>
      r.url().endsWith("/bulk/operations") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Outcome + assign 2", exact: true })
    .click();
  const command = await (await accepted).json();
  operations.push(command.operationId);
  await completed();
  for (const n of [4, 6]) {
    await row(n)
      .getByTestId("outcome")
      .getByText("interested", { exact: true })
      .waitFor({ timeout: 15000 });
  }
  await count(2);
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from inbox_t1.property_write_audit",
      )
    ).rows[0].n - before,
    4,
  );
  check(
    "click action reaches Restate, canonical SQL, Electric and list without refresh; exactly four updates",
  );
  await click(8);
  await count(1);
  const rb = await row(8).locator(".preview").boundingBox(),
    ab = await page
      .getByRole("button", { name: "Outcome + assign 1", exact: true })
      .boundingBox();
  const dropResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/bulk/operations") && r.request().method() === "POST",
  );
  await page.mouse.move(rb.x + 30, rb.y + 10);
  await page.mouse.down();
  await page.mouse.move(ab.x + 30, ab.y + 20, { steps: 15 });
  await page.mouse.up();
  operations.push((await (await dropResponse).json()).operationId);
  await completed();
  await row(8)
    .getByTestId("outcome")
    .getByText("interested", { exact: true })
    .waitFor({ timeout: 15000 });
  await count(1);
  check("drag selected row to same action executes and synchronizes");
  await click(10);
  let interceptedBody;
  let acceptedLost;
  await page.route(
    "**/bulk/operations",
    async (route) => {
      interceptedBody = route.request().postDataJSON();
      const response = await route.fetch();
      acceptedLost = await response.json();
      await route.abort("failed");
    },
    { times: 1 },
  );
  await page
    .getByRole("button", { name: "Outcome + assign 1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check same request", exact: true })
    .waitFor();
  await click(12);
  assert.equal(
    await page
      .getByRole("button", { name: "Outcome + assign 1", exact: true })
      .isDisabled(),
    true,
  );
  const retry = page.waitForResponse(
    (r) =>
      r.url().endsWith("/bulk/operations") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Check same request", exact: true })
    .click();
  const retried = await retry;
  assert.deepEqual(retried.request().postDataJSON(), interceptedBody);
  assert.equal((await retried.json()).operationId, acceptedLost.operationId);
  operations.push(acceptedLost.operationId);
  await completed();
  check(
    "lost acknowledgement keeps immutable request despite changed selection, then resolves same operation",
  );
  await page.getByLabel("Show selected only").check();
  await count(1);
  await page.getByLabel("Show selected only").uncheck();
  await count(1);
  check("view filter preserves selection");
  const held = await page
    .locator("[data-selected=true]")
    .getAttribute("data-row-id");
  // Wait on observable renewal rather than an arbitrary sleep; real60s TTL/45s renewal stays enabled.
  await page.waitForResponse(
    (r) =>
      r.url().endsWith("/sync/worksets") && r.request().method() === "POST",
    { timeout: 55000 },
  );
  await page
    .getByText("100 synchronized rows", { exact: true })
    .waitFor({ timeout: 15000 });
  await count(1);
  assert.equal(
    await page.locator("[data-selected=true]").getAttribute("data-row-id"),
    held,
  );
  check("quiet session renews bounded workset and preserves selected IDs");
  await db.query(
    "UPDATE inbox_t1.properties SET outcome='after-renewal' WHERE id=md5('inbox-t1-property-12')::uuid AND org_id='11111111-1111-4111-8111-111111111111'",
  );
  await row(12)
    .getByTestId("outcome")
    .getByText("after-renewal", { exact: true })
    .waitFor({ timeout: 15000 });
  check(
    "live canonical update still reaches UI after quiet session and replacement",
  );
  await page.screenshot({ path: "browser/verified.png" });
  assert.deepEqual(errors, []);
  check("no uncaught browser exceptions");
  await writeFile(
    "browser/evidence.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        surface: "isolated local synthetic100-row runtime",
        viewport: { width: 1440, height: 900 },
        checks,
        operations,
        limits: [
          "No production latency claim",
          "No real auth or provider sends",
          "Not complete Inbox UI parity",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} catch (e) {
  console.error((await page.locator("body").innerText()).slice(0, 2000));
  await page.screenshot({ path: "browser/failure.png" });
  throw e;
} finally {
  for (const id of worksetIds)
    await page.request.delete(`http://127.0.0.1:58790/sync/worksets/${id}`, {
      headers: { authorization: "Bearer synthetic-a" },
    });
  await browser.close();
  await db.end();
}
