import test from "node:test";
import assert from "node:assert/strict";

import { findRow, nextVirtualScrollTop, planWork, WorkloadBlocked, waitForDetailState } from "./adapter.mjs";

const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function scenario(number, targets = 2) {
  return {
    tenantId: "org-tenant",
    operatorId: id(number + 200),
    orgId: id(number),
    storageState: `/owned/auth-${number}.json`,
    assigneeId: id(number + 100),
    conversationIds: Array.from({ length: targets }, (_, index) => id(number * 10 + index + 1)),
  };
}

test("plans bounded cycles across distinct tenant/operator fixtures", () => {
  const jobs = planWork({ scenarios: [{ ...scenario(1), orgId: id(1), tenantId: "tenant-a" }, { ...scenario(2), orgId: id(2), tenantId: "tenant-b" }], cycles: 4, concurrency: 2, tenantCount: 2 });
  assert.deepEqual(jobs.map((job) => [job.scenario.tenantId, job.conversationId]), [
    ["tenant-a", id(11)],
    ["tenant-b", id(21)],
    ["tenant-a", id(12)],
    ["tenant-b", id(22)],
  ]);
});

test("allows concurrent operators to share an org while keeping auth states distinct", () => {
  const jobs = planWork({ scenarios: [scenario(1), { ...scenario(2), orgId: id(1) }], cycles: 2, concurrency: 2, tenantCount: 1 });
  assert.equal(new Set(jobs.map((job) => job.scenario.orgId)).size, 1);
  assert.equal(new Set(jobs.map((job) => job.scenario.operatorId)).size, 2);
});

test("exercises extra operator mappings instead of silently ignoring them", () => {
  const scenarios = [scenario(1), { ...scenario(2), orgId: id(1) }, { ...scenario(3), orgId: id(1) }];
  const jobs = planWork({ scenarios, cycles: 3, concurrency: 2, tenantCount: 1 });
  assert.deepEqual(jobs.map((job) => job.scenario.operatorId), [id(201), id(202), id(203)]);
});

test("rejects one auth state being reused for multiple measured operators", () => {
  assert.throws(
    () => planWork({ scenarios: [{ ...scenario(1), tenantId: "tenant-a" }, { ...scenario(1), tenantId: "tenant-b", operatorId: id(202) }], cycles: 2, concurrency: 2, tenantCount: 1 }),
    (error) => error instanceof WorkloadBlocked && /storage state/.test(error.message),
  );
});

test("rejects a measured workload without enough distinct pre-seeded targets", () => {
  assert.throws(
    () => planWork({ scenarios: [{ ...scenario(1, 1), orgId: id(1) }, { ...scenario(2, 1), orgId: id(2) }], cycles: 3, concurrency: 2, tenantCount: 2 }),
    (error) => error instanceof WorkloadBlocked && /no unique pre-seeded conversation/.test(error.message),
  );
});

test("does not count the detail shell before delayed history content is ready", async () => {
  let state = "loading";
  setTimeout(() => { state = "ready"; }, 10);
  await waitForDetailState(async () => state, 100, 1);
  assert.equal(state, "ready");
});

test("bounded virtual scrolling reaches a row beyond the initially mounted viewport", () => {
  const clientHeight = 600;
  const rowHeight = 72;
  let scrollTop = 0;
  const targetIndex = 30;
  let mounted = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const first = Math.floor(scrollTop / rowHeight);
    const last = Math.floor((scrollTop + clientHeight - 1) / rowHeight);
    if (targetIndex >= first && targetIndex <= last) {
      mounted = true;
      break;
    }
    const next = nextVirtualScrollTop({ scrollTop, scrollHeight: 500 * rowHeight, clientHeight, rowHeight });
    if (next === scrollTop) break;
    scrollTop = next;
  }
  assert.equal(mounted, true);
});

test("browser-local virtualized workset mounts a row outside the initial viewport", async () => {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  const orgId = id(900);
  const targetId = id(990);
  const conversationIds = Array.from({ length: 120 }, (_, index) => id(900 + index));
  await page.setContent(`
    <style>
      [role=list][aria-label="Inbox conversations"] { width: 800px; height: 600px; overflow: auto; }
      .canvas { position: relative; height: 8640px; }
      [data-workspace-row] { position: absolute; height: 72px; width: 100%; }
    </style>
    <div role="list" aria-label="Inbox conversations" aria-busy="false"><div class="canvas"></div></div>
    <button type="button" aria-label="Next 500" disabled>Next 500</button>
    <script>
      const list = document.querySelector('[role=list]');
      const canvas = list.querySelector('.canvas');
      const total = 120;
      const org = ${JSON.stringify(orgId)};
      const ids = ${JSON.stringify(conversationIds)};
      function render() {
        canvas.querySelectorAll('[data-workspace-row]').forEach((row) => row.remove());
        const first = Math.floor(list.scrollTop / 72);
        for (let index = first; index < Math.min(total, first + 12); index += 1) {
          const row = document.createElement('div');
          row.setAttribute('role', 'listitem');
          row.setAttribute('aria-setsize', String(total));
          row.dataset.workspaceRow = JSON.stringify([org, 'conversation', ids[index]]);
          row.style.top = (index * 72) + 'px';
          canvas.append(row);
        }
      }
      list.addEventListener('scroll', render);
      render();
    </script>
  `);
  try {
    const row = await findRow(page, orgId, targetId);
    assert.equal(await row.getAttribute("data-workspace-row"), JSON.stringify([orgId, "conversation", targetId]));
    assert.equal(await page.getByRole("list", { name: "Inbox conversations", exact: true }).evaluate((element) => element.scrollTop > 0), true);
  } finally {
    await browser.close();
  }
});
