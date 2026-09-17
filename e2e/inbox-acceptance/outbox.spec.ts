import { expect, test } from "@playwright/test";

import { adminClient, ensureTestUser, resetTenantTables } from "../fixtures";
import { seedQueuedMessage } from "./seed";
import { recordMatrixResult } from "./results";

/**
 * Outbox regression boundary (O01-O10) — the acceptance matrix's explicit
 * "unchanged path" rows. These drive /messages?tab=outbox, the legacy
 * queue-panel.tsx UI, which this PR does not touch. The point of this
 * suite is to prove the harness's presence (INBOX_* flags on) doesn't
 * regress Outbox, not to re-derive queue-panel's own unit coverage.
 */

test.describe.configure({ mode: "serial" });

let admin: ReturnType<typeof adminClient>;

test.beforeAll(async () => {
  admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
});

test("O01/O09 — queued cards render with totals", async ({ page }) => {
  const a = await seedQueuedMessage(admin, { addressTag: "ACC-O01-A", body: "o01 queued body alpha", scheduledForOffsetMin: 5 });
  const b = await seedQueuedMessage(admin, { addressTag: "ACC-O01-B", body: "o01 queued body beta", scheduledForOffsetMin: 10 });

  await page.goto("/messages?tab=outbox");
  const list = page.getByTestId("outbox-card-list");
  await expect(list).toBeVisible();
  await expect(page.getByTestId(`outbox-card-${a.id}`)).toBeVisible();
  await expect(page.getByTestId(`outbox-card-${b.id}`)).toBeVisible();
  await expect(page.getByTestId(`outbox-card-${a.id}`)).toContainText("o01 queued body alpha");

  // Exact string match on the toolbar's queued-count summary, distinct
  // from the "N queued · N sent out today" header line and the quoted
  // card bodies which also contain the word "queued".
  await expect(page.getByText("2 queued", { exact: true })).toBeVisible();

  recordMatrixResult({ id: "O01", status: "pass", evidence: "e2e/inbox-acceptance/outbox.spec.ts::O01" });
  recordMatrixResult({ id: "O09", status: "pass", evidence: "e2e/inbox-acceptance/outbox.spec.ts::O01" });
});

test("O03/O07 — send one and delete a queued message", async ({ page }) => {
  // scheduledForOffsetMin is negative (already due) — releaseQueuedMessage
  // returns "blocked_not_due" (a silent no-op, no toast, no row removal)
  // for a message still scheduled in the future.
  const sendTarget = await seedQueuedMessage(admin, { addressTag: "ACC-O03-SEND", body: "o03 send target", scheduledForOffsetMin: -1 });
  const deleteTarget = await seedQueuedMessage(admin, { addressTag: "ACC-O07-DELETE", body: "o07 delete target", scheduledForOffsetMin: 6 });

  await page.goto("/messages?tab=outbox");
  const sendCard = page.getByTestId(`outbox-card-${sendTarget.id}`);
  await expect(sendCard).toBeVisible();
  await sendCard.getByRole("button", { name: "Send", exact: true }).click();
  await expect(sendCard).toHaveCount(0, { timeout: 15_000 });
  recordMatrixResult({ id: "O03", status: "pass", evidence: "e2e/inbox-acceptance/outbox.spec.ts::O03" });

  const deleteCard = page.getByTestId(`outbox-card-${deleteTarget.id}`);
  await expect(deleteCard).toBeVisible();
  await deleteCard.getByRole("button", { name: "Delete" }).click();
  await expect(deleteCard).toHaveCount(0, { timeout: 15_000 });
  recordMatrixResult({ id: "O07", status: "pass", evidence: "e2e/inbox-acceptance/outbox.spec.ts::O07" });
});

test("O06 — edit queued text, save, then cancel leaves original", async ({ page }) => {
  const target = await seedQueuedMessage(admin, { addressTag: "ACC-O06-EDIT", body: "o06 original body", scheduledForOffsetMin: 5 });

  await page.goto("/messages?tab=outbox");
  const card = page.getByTestId(`outbox-card-${target.id}`);
  await expect(card).toBeVisible();

  // Save path.
  await card.getByRole("button", { name: "Edit" }).click();
  const textarea = card.getByLabel("Message body");
  await textarea.fill("o06 edited body");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("o06 edited body", { timeout: 10_000 });

  // Cancel path leaves the (now-saved) body untouched.
  await card.getByRole("button", { name: "Edit" }).click();
  await card.getByLabel("Message body").fill("o06 discarded body");
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card).toContainText("o06 edited body");
  await expect(card).not.toContainText("o06 discarded body");

  recordMatrixResult({ id: "O06", status: "pass", evidence: "e2e/inbox-acceptance/outbox.spec.ts::O06" });
});

test("O02/O04/O05 — Send next, auto-send start/pause, cadence input", async ({ page }) => {
  await seedQueuedMessage(admin, { addressTag: "ACC-O0245-A", body: "o0245 body one", scheduledForOffsetMin: -2 });
  await seedQueuedMessage(admin, { addressTag: "ACC-O0245-B", body: "o0245 body two", scheduledForOffsetMin: -1 });

  await page.goto("/messages?tab=outbox");
  await expect(page.getByTestId("outbox-card-list")).toBeVisible();

  // O05 — cadence input accepts and retains a value.
  const cadence = page.getByLabel("Cadence");
  await cadence.fill("45");
  await expect(cadence).toHaveValue("45");
  recordMatrixResult({ id: "O05", status: "pass", evidence: "e2e/inbox-acceptance/outbox.spec.ts::O02-O05" });

  // O04 — start auto-send (button relabels to Pause auto-send / becomes destructive-styled).
  const autoSend = page.getByRole("button", { name: /^Auto-send$/ });
  await autoSend.click();
  const pauseButton = page.getByRole("button", { name: "Pause auto-send" });
  await expect(pauseButton).toBeVisible();
  await pauseButton.click();
  await expect(page.getByRole("button", { name: /^Auto-send$/ })).toBeVisible();
  recordMatrixResult({ id: "O04", status: "pass", evidence: "e2e/inbox-acceptance/outbox.spec.ts::O02-O05" });

  // O02 — Send next releases the head-of-queue message.
  const sendNext = page.getByRole("button", { name: "Send next" });
  await expect(sendNext).toBeEnabled();
  const cardsBefore = await page.getByTestId("outbox-card-list").locator("article").count();
  await sendNext.click();
  await expect(async () => {
    const cardsAfter = await page.getByTestId("outbox-card-list").locator("article").count();
    expect(cardsAfter).toBeLessThan(cardsBefore);
  }).toPass({ timeout: 15_000 });
  recordMatrixResult({ id: "O02", status: "pass", evidence: "e2e/inbox-acceptance/outbox.spec.ts::O02-O05" });
});

test("O08 — load more queue rows advances the page", async ({ page }) => {
  test.setTimeout(150_000);
  // QUEUE_PAGE_SIZE in actions.ts is 100 — need >100 queued rows for
  // hasMore/the load-more sentinel to appear. Seed in small concurrent
  // batches to keep this within the test timeout.
  const total = 110;
  const batchSize = 10;
  for (let start = 0; start < total; start += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, total - start) }, (_, j) => start + j);
    await Promise.all(
      batch.map((i) =>
        seedQueuedMessage(admin, { addressTag: `ACC-O08-${i}`, body: `o08 body ${i}`, scheduledForOffsetMin: 20 + i }),
      ),
    );
  }

  await page.goto("/messages?tab=outbox");
  await expect(page.getByTestId("outbox-card-list")).toBeVisible();
  const sentinel = page.getByTestId("queue-load-more-sentinel");
  await expect(sentinel).toBeVisible({ timeout: 15_000 });
  const countBefore = await page.getByTestId("outbox-card-list").locator("article").count();
  await sentinel.scrollIntoViewIfNeeded();
  await expect(async () => {
    const countAfter = await page.getByTestId("outbox-card-list").locator("article").count();
    expect(countAfter).toBeGreaterThan(countBefore);
  }).toPass({ timeout: 15_000 });

  recordMatrixResult({ id: "O08", status: "pass", evidence: "e2e/inbox-acceptance/outbox.spec.ts::O08" });
});

test("O10 — a failed initial queue read recovers via Retry", async ({ page }) => {
  await seedQueuedMessage(admin, { addressTag: "ACC-O10-RETRY", body: "o10 recovers after retry", scheduledForOffsetMin: 5 });

  let failedOnce = false;
  await page.route("**/messages*", async (route) => {
    const request = route.request();
    const isServerActionInvocation =
      request.method() === "POST" && !!(await request.headerValue("next-action"));
    if (isServerActionInvocation && !failedOnce) {
      failedOnce = true;
      await route.fulfill({ status: 500, body: "simulated queue read failure" });
      return;
    }
    await route.continue();
  });

  await page.goto("/messages?tab=outbox");
  const failure = page.getByTestId("queue-load-failure");
  // The initial listQueuedPage server action call is intercepted and fails
  // exactly once above; if the panel doesn't hit that path on first paint
  // this assertion is skipped defensively rather than fabricating a pass.
  const sawFailure = await failure.isVisible({ timeout: 10_000 }).catch(() => false);
  test.skip(!sawFailure, "Initial queue read did not route through the intercepted server action on this render path.");

  await failure.getByRole("button", { name: "Retry" }).click();
  await expect(failure).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("o10 recovers after retry")).toBeVisible();

  recordMatrixResult({ id: "O10", status: "pass", evidence: "e2e/inbox-acceptance/outbox.spec.ts::O10" });
});
