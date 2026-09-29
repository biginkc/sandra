import test from "node:test";
import assert from "node:assert/strict";

import { findRow, measuredRecord, nextVirtualScrollTop, planWork, runWorkloadCycles, sourceArrivalTiming, waitForDetailState, waitForSelectionFeedback, WorkloadBlocked } from "./adapter.mjs";

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

test("counts only delayed source arrival to the exact projected version", () => {
  const record = sourceArrivalTiming("current", {
    targetId: id(700),
    sourceMessageId: id(701),
    inboundRevision: 3,
    sourceCaptureGeneration: 8,
    arrivalAtMs: 10_000,
    observedAtMs: 10_250,
    projectedVersion: 4,
  });
  assert.deepEqual(record, {
    type: "timing",
    profile: "current",
    event: "ingestion",
    duration_ms: 250,
    sample: {
      boundary: "source_arrival_to_exact_projected_version",
      source: "owned_provider_double_or_source_fixture",
      targetId: id(700),
      sourceMessageId: id(701),
      inboundRevision: 3,
      sourceCaptureGeneration: 8,
      arrivalAtMs: 10_000,
      observedAtMs: 10_250,
      projectedVersion: 4,
    },
  });
});

test("does not count a preexisting row as source ingestion", () => {
  assert.throws(
    () => sourceArrivalTiming("current", {
      targetId: id(702),
      sourceMessageId: id(703),
      observedAtMs: 10_250,
      projectedVersion: 1,
    }),
    (error) => error instanceof WorkloadBlocked && /arrivalAtMs/.test(error.message),
  );
  assert.throws(
    () => sourceArrivalTiming("current", {
      targetId: id(702),
      sourceMessageId: id(703),
      arrivalAtMs: 10_250,
      observedAtMs: 10_250,
      projectedVersion: 1,
    }),
    (error) => error instanceof WorkloadBlocked && /after source arrival/.test(error.message),
  );
});

test("emits bounded observed operator arrival records", () => {
  assert.deepEqual(
    measuredRecord("metric", "three_x", {
      name: "operator_arrival_rate_rps",
      value: 3.25,
      sample: { basis: "observed_operator_cycle_start_interval" },
    }),
    {
      type: "metric",
      profile: "three_x",
      name: "operator_arrival_rate_rps",
      value: 3.25,
      sample: { basis: "observed_operator_cycle_start_interval" },
    },
  );
  assert.throws(() => measuredRecord("timing", "current", { event: "queue", duration_ms: -1 }), WorkloadBlocked);
  assert.throws(() => measuredRecord("metric", "current", { name: "operator_arrival_rate_rps", value: Number.NaN }), WorkloadBlocked);
});

test("publishes readiness only after the first browser cycle starts", async () => {
  const events = [];
  let browserLaunched = false;
  let releaseLaunch;
  const launch = new Promise((resolve) => { releaseLaunch = resolve; });
  const jobs = [{ index: 0, scenario: {}, conversationId: id(800) }, { index: 1, scenario: {}, conversationId: id(801) }];
  const run = launch.then(() => runWorkloadCycles({
    browser: {},
    input: { arrivalIntervalMs: 0 },
    jobs,
    concurrency: 2,
    onFirstCycleStart: () => {
      assert.equal(browserLaunched, true);
      events.push("ready");
    },
    cycleRunner: async (_browser, _input, _job, _sample, onCycleStart) => {
      events.push("cycle-open");
      await onCycleStart();
      events.push("cycle-work");
      return { metadataOperationId: `metadata-${_job.index}`, replyOperationId: `reply-${_job.index}` };
    },
  }));

  // A delayed browser launch must not publish the marker or start a cycle.
  await Promise.resolve();
  assert.deepEqual(events, []);
  browserLaunched = true;
  releaseLaunch();
  await run;
  assert.equal(events.filter((event) => event === "ready").length, 1);
  const readyIndex = events.indexOf("ready");
  assert.ok(readyIndex >= 0);
  assert.ok(events.slice(0, readyIndex).every((event) => event === "cycle-open"));
  assert.ok(events.slice(readyIndex + 1).includes("cycle-work"));
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
  const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
  const orgId = id(900);
  const targetId = id(1499);
  const conversationIds = Array.from({ length: 500 }, (_, index) => id(1000 + index));
  await page.setContent(`
    <style>
      [role=list][aria-label="Inbox conversations"] { width: 800px; height: 300px; overflow: auto; }
      .canvas { position: relative; height: 36000px; }
      [data-workspace-row] { position: absolute; height: 72px; width: 100%; }
    </style>
    <div role="list" aria-label="Inbox conversations" aria-busy="false"><div class="canvas"></div></div>
    <button type="button" aria-label="Next 500" disabled>Next 500</button>
    <script>
      const list = document.querySelector('[role=list]');
      const canvas = list.querySelector('.canvas');
      const total = 500;
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

test("bounded row lookup stops when the list never reports a ready workset", async () => {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent('<div role="list" aria-label="Inbox conversations" aria-busy="true"></div>');
  try {
    await assert.rejects(
      () => findRow(page, id(901), id(902), { timeoutMs: 20 }),
      (error) => error instanceof WorkloadBlocked && /absent after scanning/.test(error.message),
    );
  } finally {
    await browser.close();
  }
});

test("bounded row lookup tolerates a transient empty replacement before retry", async () => {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const orgId = id(903);
  const conversationId = id(904);
  await page.setContent(`<div role="list" aria-label="Inbox conversations" aria-busy="false"></div><script>
    setTimeout(() => {
      const list = document.querySelector('[role=list]');
      list.setAttribute('aria-setsize', '1');
      const row = document.createElement('div');
      row.setAttribute('data-workspace-row', JSON.stringify([${JSON.stringify(orgId)}, 'conversation', ${JSON.stringify(conversationId)}]));
      list.append(row);
    }, 40);
  </script>`);
  try {
    const row = await findRow(page, orgId, conversationId, { timeoutMs: 500 });
    assert.equal(await row.getAttribute("data-workspace-row"), JSON.stringify([orgId, "conversation", conversationId]));
  } finally {
    await browser.close();
  }
});

test("selection timing scopes the exact feedback node when the action rail repeats its text", async () => {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(`
    <section aria-label="Conversation selection">
      <strong aria-live="polite">1 selected</strong>
    </section>
    <aside aria-label="Actions for selection">
      <p role="status">1 selected · click or drag</p>
    </aside>
  `);
  try {
    const feedback = await waitForSelectionFeedback(page);
    assert.equal(await feedback.textContent(), "1 selected");
    assert.equal(await page.locator('section[aria-label="Conversation selection"] strong[aria-live="polite"]').count(), 1);
    assert.equal(await page.locator('aside[aria-label="Actions for selection"] p[role="status"]').count(), 1);
  } finally {
    await browser.close();
  }
});
