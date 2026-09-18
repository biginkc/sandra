import { expect, test } from "./fixture";
import { resetAcceptanceFixture } from "./cleanup";

import { adminClient, ensureTestUser } from "../fixtures";
import { seedQueuedMessage } from "./seed";
import { armOutboxInitialReadFailure } from "./fault-proxy";
import { captureRowEvidence, purgeRowOutcomes, readMatrixResults, recordRowOutcome } from "./results";

/**
 * Outbox regression boundary (O01-O10) — the acceptance matrix's explicit
 * "unchanged path" rows. These drive /messages?tab=outbox, the legacy
 * queue-panel.tsx UI, which this PR does not touch. The point of this
 * suite is to prove the harness's presence (INBOX_* flags on) doesn't
 * regress Outbox, not to re-derive queue-panel's own unit coverage.
 *
 * Every row this suite owns is registered in ROW_OWNERSHIP below and
 * gets a genuine per-run outcome (pass/fail/skip) — see the afterEach
 * hook. A row's assertions record "pass" the moment they're verified; if
 * a test fails or is skipped before reaching a row's assertions, the
 * afterEach hook backfills that row as fail/skip so a stale pass can
 * never linger from an earlier run (global-setup.ts resets every row to
 * a known baseline before any test runs, and this is what keeps that
 * baseline honest through THIS run's real outcome).
 */

test.skip(
  process.env.INBOX_ACCEPTANCE_RUN !== "1",
  "Use playwright.inbox-acceptance.config.ts for the owned Outbox fixture.",
);

test.describe.configure({ mode: "serial" });

let admin: ReturnType<typeof adminClient>;

test.beforeAll(async () => {
  admin = adminClient();
  await resetAcceptanceFixture(admin);
  await ensureTestUser(admin);
});

const ROW_OWNERSHIP: Record<string, string[]> = {
  "O01 — queued cards render with totals": ["O01"],
  "O03/O07 — send one and delete a queued message": ["O03", "O07"],
  "O06 — edit queued text, save, then cancel leaves original": ["O06"],
  "O04/O05 — auto-send start/pause, cadence input": ["O04", "O05"],
  "O02 — Send next releases the head-of-queue message via that click alone": ["O02"],
  "O08/O09 — load more queue rows advances the page, loaded total updates": ["O08", "O09"],
  "O10 — a failed initial queue read recovers via Retry": ["O10"],
};

test.beforeEach(async ({}, testInfo) => {
  // Astra round-3 finding #2: a retried attempt must never let an
  // earlier attempt's "pass" for the same row survive if THIS (possibly
  // final) attempt fails before re-recording it. Purge any prior
  // recordings for this test's owned rows before the attempt runs, so by
  // the time afterEach checks "already recorded", it can only see
  // outcomes from THIS attempt.
  const ids = ROW_OWNERSHIP[testInfo.title] ?? [];
  purgeRowOutcomes(ids);
});

test.afterEach(async ({}, testInfo) => {
  const ids = ROW_OWNERSHIP[testInfo.title] ?? [];
  const alreadyRecorded = new Set(readMatrixResults().map((r) => r.id));
  for (const id of ids) {
    if (alreadyRecorded.has(id)) continue; // the test body already recorded a genuine outcome for THIS attempt
    if (testInfo.status === "skipped") {
      recordRowOutcome({ id, status: "skip", evidence: `test skipped (no explicit reason recorded for ${id})` });
    } else {
      const detail = testInfo.error?.message?.slice(0, 300) ?? "no assertion for this row completed";
      recordRowOutcome({ id, status: "fail", evidence: `test ${testInfo.status ?? "failed"}: ${detail}` });
    }
  }
});

test("O01 — queued cards render with totals", async ({ page }) => {
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

  const evidence = await captureRowEvidence(page, "O01");
  recordRowOutcome({ id: "O01", status: "pass", evidence });
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
  // Card disappearance alone is ambiguous — the unchanged Outbox also
  // removes a card on a blocked/failed release (see releaseMessage's
  // switch in queue-panel.tsx: several blocked_* outcomes also filter the
  // row out). The real success signal is the message row's own status
  // transitioning to "sent" in the database.
  await expect
    .poll(async () => {
      const { data } = await admin.from("messages").select("status").eq("id", sendTarget.id).maybeSingle();
      return data?.status ?? null;
    }, { timeout: 10_000 })
    .toBe("sent");
  const o03Evidence = await captureRowEvidence(page, "O03");
  recordRowOutcome({ id: "O03", status: "pass", evidence: o03Evidence });

  const deleteCard = page.getByTestId(`outbox-card-${deleteTarget.id}`);
  await expect(deleteCard).toBeVisible();
  await deleteCard.getByRole("button", { name: "Delete" }).click();
  await expect(deleteCard).toHaveCount(0, { timeout: 15_000 });
  // Delete is unambiguous (the row is truly gone, not just filtered from
  // a UI list) — confirm directly against the database too.
  const { data: deletedRow } = await admin.from("messages").select("id").eq("id", deleteTarget.id).maybeSingle();
  expect(deletedRow).toBeNull();
  const o07Evidence = await captureRowEvidence(page, "O07");
  recordRowOutcome({ id: "O07", status: "pass", evidence: o07Evidence });
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

  const evidence = await captureRowEvidence(page, "O06");
  recordRowOutcome({ id: "O06", status: "pass", evidence });
});

test("O04/O05 — auto-send start/pause, cadence input", async ({ page }) => {
  // These two rows only assert UI control state (button labels, input
  // value) — NOT which message ends up sent — so it's safe for them to
  // share a test even though clicking "Auto-send" fires a real send
  // (queue-panel.tsx's auto-send effect sends immediately on start, not
  // just on the cadence tick). That immediate send is exactly why O02
  // is NOT in this test — see the O02 test below.
  await seedQueuedMessage(admin, { addressTag: "ACC-O045-A", body: "o045 body one", scheduledForOffsetMin: -2 });
  await seedQueuedMessage(admin, { addressTag: "ACC-O045-B", body: "o045 body two", scheduledForOffsetMin: -1 });

  await page.goto("/messages?tab=outbox");
  await expect(page.getByTestId("outbox-card-list")).toBeVisible();

  // O05 — cadence input accepts and retains a value.
  const cadence = page.getByLabel("Cadence");
  await cadence.fill("45");
  await expect(cadence).toHaveValue("45");
  const o05Evidence = await captureRowEvidence(page, "O05");
  recordRowOutcome({ id: "O05", status: "pass", evidence: o05Evidence });

  // O04 — start auto-send (button relabels to Pause auto-send / becomes destructive-styled).
  const autoSend = page.getByRole("button", { name: /^Auto-send$/ });
  await autoSend.click();
  const pauseButton = page.getByRole("button", { name: "Pause auto-send" });
  await expect(pauseButton).toBeVisible();
  await pauseButton.click();
  await expect(page.getByRole("button", { name: /^Auto-send$/ })).toBeVisible();
  const o04Evidence = await captureRowEvidence(page, "O04");
  recordRowOutcome({ id: "O04", status: "pass", evidence: o04Evidence });
});

test("O02 — Send next releases the head-of-queue message via that click alone", async ({ page }) => {
  // Isolated on purpose (Astra round-3 finding #1): a prior combined
  // O02/O04/O05 test clicked "Auto-send" (O04) before "Send next" (O02).
  // queue-panel.tsx's auto-send effect fires an immediate send the
  // moment autoOn becomes true — not only on the cadence tick — so that
  // earlier click had ALREADY sent the head-of-queue message before
  // "Send next" was ever clicked, and O02's assertion passed for the
  // wrong reason (it would have passed even with the "Send next" click
  // deleted from the test). This test never touches cadence or
  // auto-send at all — the ONLY control that can transition this
  // message to "sent" is the "Send next" click itself.
  //
  // Full isolation, not just "don't click auto-send": this suite's
  // earlier tests (O01/O03/O07/O06/O04/O05) leave their own leftover
  // queued rows in the shared DB (test.describe.configure({mode:
  // "serial"}) means one beforeAll for the whole file, not a reset per
  // test). Resetting here makes `target` the ONLY queued row in
  // existence when "Send next" is clicked — no ambiguity about which
  // row is "head of queue", and nothing else in the whole DB state
  // could account for it becoming "sent" besides this click.
  await resetAcceptanceFixture(admin);
  await ensureTestUser(admin);
  const target = await seedQueuedMessage(admin, { addressTag: "ACC-O02-ONLY", body: "o02 isolated body", scheduledForOffsetMin: -2 });

  await page.goto("/messages?tab=outbox");
  const sendNext = page.getByRole("button", { name: "Send next" });
  await expect(sendNext).toBeEnabled();

  // eslint-disable-next-line no-constant-condition -- verification toggle, see comment below
  const CLICK_SEND_NEXT = true;
  // Proof this test actually isolates the requirement (Astra round-3):
  // with CLICK_SEND_NEXT flipped to false, nothing else in this test can
  // send `target` — the poll below times out and the test FAILS. Verified
  // manually before restoring this to `true`; left as a literal (not a
  // runtime env toggle) so it can't accidentally ship flipped.
  if (CLICK_SEND_NEXT) {
    await sendNext.click();
  }

  await expect
    .poll(async () => {
      const { data } = await admin.from("messages").select("status").eq("id", target.id).maybeSingle();
      return data?.status ?? null;
    }, { timeout: 15_000 })
    .toBe("sent");
  await expect(page.getByTestId(`outbox-card-${target.id}`)).toHaveCount(0, { timeout: 15_000 });

  const evidence = await captureRowEvidence(page, "O02");
  recordRowOutcome({ id: "O02", status: "pass", evidence });
});

test("O08/O09 — load more queue rows advances the page, loaded total updates", async ({ page }) => {
  test.setTimeout(150_000);
  // QUEUE_PAGE_SIZE in actions.ts is 100 — need >100 queued rows for
  // hasMore/the load-more sentinel AND the "N of M loaded" total (O09) to
  // appear. Seed in small concurrent batches to keep this within timeout.
  //
  // The suite runs test.describe.configure({mode:"serial"}) against one
  // shared DB (beforeAll resets it only once for the whole file), so
  // earlier tests' still-queued rows (O01's two future-scheduled cards,
  // O06's edited row, O02/O04/O05's second message) are still present
  // here too — read the actual pre-existing queued count instead of
  // assuming a bare "110" total, or this assertion is exactly as fragile
  // as the card-disappearance check Astra flagged elsewhere.
  const { count: preexistingQueued } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued");
  const newlySeeded = 110;
  const expectedTotal = (preexistingQueued ?? 0) + newlySeeded;
  const batchSize = 10;
  for (let start = 0; start < newlySeeded; start += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, newlySeeded - start) }, (_, j) => start + j);
    await Promise.all(
      batch.map((i) =>
        seedQueuedMessage(admin, { addressTag: `ACC-O08-${i}`, body: `o08 body ${i}`, scheduledForOffsetMin: 20 + i }),
      ),
    );
  }

  await page.goto("/messages?tab=outbox");
  await expect(page.getByTestId("outbox-card-list")).toBeVisible();

  // O09 — the toolbar shows the paginated "N of M loaded" total once more
  // rows exist than fit on one page (distinct from O01's simple "N
  // queued" case, which never exercises this format).
  await expect(page.getByText(`100 of ${expectedTotal} loaded`, { exact: true })).toBeVisible();
  const o09Evidence = await captureRowEvidence(page, "O09");
  recordRowOutcome({ id: "O09", status: "pass", evidence: o09Evidence });

  // O08 — scrolling the sentinel into view loads more rows.
  const sentinel = page.getByTestId("queue-load-more-sentinel");
  await expect(sentinel).toBeVisible({ timeout: 15_000 });
  const countBefore = await page.getByTestId("outbox-card-list").locator("article").count();
  await sentinel.scrollIntoViewIfNeeded();
  await expect(async () => {
    const countAfter = await page.getByTestId("outbox-card-list").locator("article").count();
    expect(countAfter).toBeGreaterThan(countBefore);
  }).toPass({ timeout: 15_000 });

  const o08Evidence = await captureRowEvidence(page, "O08");
  recordRowOutcome({ id: "O08", status: "pass", evidence: o08Evidence });
});

test("O10 — a failed initial queue read recovers via Retry", async ({ page }) => {
  await seedQueuedMessage(admin, { addressTag: "ACC-O10-RETRY", body: "o10 recovers after retry", scheduledForOffsetMin: 5 });

  // The first queue page is rendered by the server component and its
  // Supabase request never traverses the browser page, so a page.route()
  // interception cannot exercise this failure path. Arm the acceptance-only
  // loopback Supabase proxy instead; it faults exactly this queued REST read
  // once and forwards the retry to the real seeded database.
  await armOutboxInitialReadFailure();

  await page.goto("/messages?tab=outbox");
  const failure = page.getByTestId("queue-load-failure");
  await expect(failure).toBeVisible({ timeout: 15_000 });
  await failure.getByRole("button", { name: "Retry" }).click();
  await expect(failure).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("o10 recovers after retry")).toBeVisible();

  const evidence = await captureRowEvidence(page, "O10");
  recordRowOutcome({ id: "O10", status: "pass", evidence });
});
