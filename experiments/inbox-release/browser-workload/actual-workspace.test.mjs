import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { findRow, waitForSelectionFeedback } from "./adapter.mjs";

/**
 * Browser-local workload contract for the real InboxWorkspace component.
 *
 * This is intentionally a small DOM/readiness check, not a performance or
 * stress run. The fixture supplies controlled local callbacks as the adapter
 * transport double; no API, database, provider, or timer-driven arrival is
 * involved. It catches two ordinary harness mistakes: selecting by ambiguous
 * "1 selected" text and assuming virtualized offscreen rows are mounted.
 *
 * Run only when a local browser is available:
 *   node experiments/inbox-release/browser-workload/actual-workspace.test.mjs
 */

const fixture = fileURLToPath(new URL("./actual-workspace.fixture.tsx", import.meta.url));
const runtime = await mkdtemp(join(tmpdir(), "sandra-inbox-workload-"));
const bundlePath = join(runtime, "actual-workspace.js");
const cssPath = join(runtime, "actual-workspace.css");
const orgId = "00000000-0000-4000-8000-000000000001";
const conversationIdFor = (index) => `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`;

await build({
  entryPoints: [fixture],
  outfile: bundlePath,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Inbox workload contract</title><link rel="stylesheet" href="/actual-workspace.css"></head>
<body><div id="root"></div><script type="module" src="/actual-workspace.js"></script></body></html>`;

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method !== "GET") {
    response.writeHead(405).end();
    return;
  }
  if (pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    return;
  }
  const assets = new Map([
    ["/actual-workspace.js", [bundlePath, "text/javascript; charset=utf-8"]],
    ["/actual-workspace.css", [cssPath, "text/css; charset=utf-8"]],
  ]);
  const asset = assets.get(pathname);
  if (!asset) {
    response.writeHead(404).end();
    return;
  }
  try {
    response.writeHead(200, { "content-type": asset[1], "cache-control": "no-store" }).end(await readFile(asset[0]));
  } catch {
    response.writeHead(503).end("asset unavailable");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not determine local workload server port.");
const url = `http://127.0.0.1:${address.port}/`;

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(url, { waitUntil: "load" });
  await expect(page.getByTestId("adapter-ready")).toBeVisible();

  const list = page.getByRole("list", { name: "Inbox conversations" });
  const firstRow = await findRow(page, orgId, conversationIdFor(0));
  await expect(firstRow).toContainText("Person 0");
  await firstRow.getByRole("button", { name: "Open Person 0" }).click();
  await expect(page.getByTestId("inspection")).toHaveText("Inspection for Person 0");
  await page.getByRole("button", { name: "Close conversation details" }).click();
  await expect(page.getByRole("complementary", { name: "Open conversation" })).toHaveCount(0);
  const revisitRow = await findRow(page, orgId, conversationIdFor(0));
  await revisitRow.getByRole("button", { name: "Open Person 0" }).click();
  await expect(page.getByTestId("inspection")).toHaveText("Inspection for Person 0");
  await expect(page.getByTestId("transport-log")).toContainText("inspect:");
  await page.getByRole("button", { name: "Close conversation details" }).click();

  const selectionRow = await findRow(page, orgId, conversationIdFor(0));
  await selectionRow.getByLabel("Select Person 0").check();
  await waitForSelectionFeedback(page, 1);
  await expect(page.getByText("1 selected", { exact: true })).toHaveCount(1);
  await expect(page.getByText("1 selected")).toHaveCount(2);

  const mountedBeforeScroll = await list.getByRole("listitem").count();
  expect(mountedBeforeScroll).toBeLessThan(120);
  await expect(list.getByText("Person 119", { exact: true })).toHaveCount(0);
  const offscreenRow = await findRow(page, orgId, conversationIdFor(119));
  await expect(offscreenRow).toContainText("Person 119");
  await offscreenRow.getByLabel("Select Person 119").check();
  await waitForSelectionFeedback(page, 2);
  await expect(page.getByText("2 selected", { exact: true })).toHaveCount(1);
  await expect(page.getByTestId("transport-log")).toContainText("select:1|select:2");

  console.log(JSON.stringify({
    passed: true,
    checks: [
      "actual detail inspection and revisit preserve the controlled component contract",
      "ambiguous selection text has one exact-match control and two substring matches",
      "the real virtualizer mounts fewer than 120 rows and admits the offscreen row after scroll",
      "selection can add the admitted offscreen row without losing the first selection",
    ],
    mountedBeforeScroll,
    limits: ["Local deterministic callbacks only; no API, database, provider, or workload timing evidence"],
  }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(runtime, { recursive: true, force: true });
}
