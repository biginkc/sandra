import { expect, test, type Page } from "@playwright/test";

import { adminClient, ensureTestUser, resetTenantTables } from "../fixtures";
import { captureRowEvidence, purgeRowOutcomes, readMatrixResults, recordRowOutcome } from "./results";
import { seedAcceptanceThread, type SeededThread } from "./seed";

/**
 * Cross-surface navigation and selection contracts for the new Inbox.
 *
 * The F01 journey deliberately starts in the existing Messages shell,
 * enters the pilot-gated overview/workspace, returns through the overview,
 * and proves the unchanged Messages Outbox remains reachable. The other
 * tests cover behavior that has no separate matrix row: selection is local to
 * the authenticated session, Open is distinct from selection, and filtering
 * does not discard selected IDs that are temporarily outside the resident
 * view.
 *
 * Runtime is enabled only by the dedicated acceptance configuration. These
 * tests use the real browser, APIs, and persisted fixture rows; they do not
 * intercept Inbox routes or treat a screenshot as the assertion.
 */

const shouldRun = process.env.INBOX_ACCEPTANCE_RUN === "1";
const ROW_OWNERSHIP: Record<string, string[]> = {
  "F01 — Messages enters Inbox overview/workspace and preserves Outbox": ["F01"],
};

let admin: ReturnType<typeof adminClient>;
let selectionPhoneCounter = 7_000_000;

test.describe.configure({ mode: "serial" });

test.describe("Inbox navigation and selection", () => {
  test.skip(
    !shouldRun,
    "Runtime-unproven: set INBOX_ACCEPTANCE_RUN=1 through the dedicated acceptance config after coordinator runtime handoff.",
  );

  test.beforeAll(async () => {
    admin = adminClient();
    await resetTenantTables(admin);
    await ensureTestUser(admin);
  });

  test.beforeEach(async ({}, testInfo) => {
    purgeRowOutcomes(ROW_OWNERSHIP[testInfo.title] ?? []);
    await resetTenantTables(admin);
    await ensureTestUser(admin);
  });

  test.afterEach(async ({ page }, testInfo) => {
    const ids = ROW_OWNERSHIP[testInfo.title] ?? [];
    if (!shouldRun || ids.length === 0) return;
    const alreadyRecorded = new Set(readMatrixResults().map((result) => result.id));
    for (const id of ids) {
      if (alreadyRecorded.has(id)) continue;
      if (testInfo.status === "skipped") {
        recordRowOutcome({ id, status: "skip", evidence: `test skipped (no explicit reason recorded for ${id})` });
        continue;
      }
      if (testInfo.status === "passed") {
        try {
          const evidence = await captureRowEvidence(page, id);
          recordRowOutcome({ id, status: "pass", evidence });
          continue;
        } catch (error) {
          const detail = error instanceof Error ? error.message.slice(0, 300) : "evidence capture failed";
          recordRowOutcome({ id, status: "fail", evidence: `evidence capture failed: ${detail}` });
          continue;
        }
      }
      const detail = testInfo.error?.message?.slice(0, 300) ?? "no assertion for this row completed";
      recordRowOutcome({ id, status: "fail", evidence: `test ${testInfo.status ?? "failed"}: ${detail}` });
    }
  });

  test("F01 — Messages enters Inbox overview/workspace and preserves Outbox", async ({ page }) => {
    await page.goto("/messages");
    await expect(page.getByTestId("messages-inbox-overview-link")).toBeVisible();
    await page.getByTestId("messages-inbox-overview-link").click();
    await expect(page).toHaveURL(/\/inbox\/overview$/);
    await expect(page.getByRole("heading", { name: "Inbox overview" })).toBeVisible();

    await page.getByRole("link", { name: "Open Inbox workspace" }).click();
    await expect(page).toHaveURL(/\/inbox\?view=all$/);
    await expect(page.getByRole("heading", { name: "Inbox workspace" })).toBeVisible();

    await page.getByRole("button", { name: "← Back to Inbox overview" }).click();
    await expect(page).toHaveURL(/\/inbox\/overview$/);
    await page.getByRole("link", { name: /Back to Messages/ }).click();
    await expect(page).toHaveURL(/\/messages$/);

    await page.getByTestId("tab-outbox").click();
    await expect(page).toHaveURL(/\/messages\?tab=outbox$/);
    await expect(page.getByTestId("messages-outbox-panel")).toBeVisible();
  });

  test("selection supports single, modifier-checkbox, and Shift-toggle interactions without opening", async ({ page }) => {
    const first = await seedSelectionThread("SEL-SINGLE", "Single", "Selection");
    const second = await seedSelectionThread("SEL-MODIFIER", "Modifier", "Selection");
    const third = await seedSelectionThread("SEL-SHIFT", "Shift", "Selection");

    await openWorkspace(page);
    const firstRow = rowFor(page, first);
    await firstRow.getByText(first.contactName, { exact: true }).click();
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Open conversation" })).toHaveCount(0);

    // Checkbox toggles are the keyboard and Cmd/Ctrl-safe equivalent of the
    // nonstandard Shift-click gesture; the nested control must not replace the
    // existing selected group through the row click handler.
    await page.getByLabel(`Select ${second.contactName}`).click({ modifiers: ["Control"] });
    await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
    await page.getByLabel(`Select ${third.contactName}`).click({ modifiers: ["Meta"] });
    await expect(page.getByText("3 selected", { exact: true })).toBeVisible();

    await rowFor(page, third).getByText(third.contactName, { exact: true }).click({ modifiers: ["Shift"] });
    await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
    await rowFor(page, second).getByText(second.contactName, { exact: true }).click({ modifiers: ["Shift"] });
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Open conversation" })).toHaveCount(0);
  });

  test("Open inspects and acknowledges read state while selection-only click does neither", async ({ page }) => {
    const thread = await seedSelectionThread("SEL-OPEN", "Explicit", "Open", { read: false });
    await openWorkspace(page);
    const row = rowFor(page, thread);

    await row.getByText(thread.contactName, { exact: true }).click();
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Open conversation" })).toHaveCount(0);
    await expect.poll(() => latestInboundReadAt(thread)).toBeNull();

    const acknowledgmentRequests: string[] = [];
    page.on("request", request => {
      if (request.url().includes("/api/inbox/read-acknowledgments")) acknowledgmentRequests.push(request.url());
    });
    await row.getByRole("button", { name: `Open ${thread.contactName}` }).click();
    await expect(page.getByRole("complementary", { name: "Open conversation" })).toBeVisible();
    await expect.poll(() => acknowledgmentRequests.length).toBeGreaterThan(0);
    await expect.poll(() => latestInboundReadAt(thread), { timeout: 10_000 }).not.toBeNull();
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  });

  test("Shift-drag selects the resident range and drag-drop opens the same review flow", async ({ page }) => {
    const first = await seedSelectionThread("SEL-GESTURE-FIRST", "Gesture", "First");
    const second = await seedSelectionThread("SEL-GESTURE-SECOND", "Gesture", "Second");
    const third = await seedSelectionThread("SEL-GESTURE-THIRD", "Gesture", "Third");
    await openWorkspace(page);

    const firstBox = await rowFor(page, first).boundingBox();
    const thirdBox = await rowFor(page, third).boundingBox();
    expect(firstBox).not.toBeNull();
    expect(thirdBox).not.toBeNull();
    await page.keyboard.down("Shift");
    await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(thirdBox!.x + thirdBox!.width / 2, thirdBox!.y + thirdBox!.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Open conversation" })).toHaveCount(0);

    const assign = page.getByRole("button", { name: "Assign", exact: true });
    await expect(assign).toBeVisible();
    const secondBox = await rowFor(page, second).boundingBox();
    const assignBox = await assign.boundingBox();
    expect(secondBox).not.toBeNull();
    expect(assignBox).not.toBeNull();
    await page.mouse.move(secondBox!.x + secondBox!.width / 2, secondBox!.y + secondBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(assignBox!.x + assignBox!.width / 2, assignBox!.y + assignBox!.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByRole("dialog")).toContainText("Assign conversations");
  });

  test("filter changes retain hidden selected IDs for Review selection", async ({ page }) => {
    const unread = await seedSelectionThread("SEL-HIDDEN-UNREAD", "Visible", "Selection", { read: false });
    const read = await seedSelectionThread("SEL-HIDDEN-READ", "Hidden", "Selection", { read: true });
    await openWorkspace(page);

    await page.getByLabel(`Select ${unread.contactName}`).click();
    await page.getByLabel(`Select ${read.contactName}`).click();
    await expect(page.getByText("2 selected", { exact: true })).toBeVisible();

    await page.getByLabel("View").selectOption("unread");
    await expect(page.getByRole("list", { name: "Inbox conversations" }).getByText(unread.contactName, { exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Inbox conversations" }).getByText(read.contactName, { exact: true })).toHaveCount(0);
    await expect(page.getByText("2 selected · 1 not loaded here", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Review selection" }).click();
    const review = page.getByRole("dialog");
    await expect(review).toBeVisible();
    await expect(review.getByText(unread.contactName, { exact: true })).toBeVisible();
    await expect(review.getByText(read.contactName, { exact: true })).toBeVisible();
  });
});

async function openWorkspace(page: Page): Promise<void> {
  await page.goto("/inbox?view=all");
  await expect(page.getByRole("heading", { name: "Inbox workspace" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Inbox conversations" })).toBeVisible();
}

function rowFor(page: Page, thread: SeededThread) {
  return page.getByRole("listitem", { name: new RegExp(`^${escapeRegExp(thread.contactName)}`) });
}

async function seedSelectionThread(
  addressTag: string,
  first: string,
  last: string,
  options: { read?: boolean } = {},
): Promise<SeededThread> {
  selectionPhoneCounter += 1;
  return seedAcceptanceThread(admin, {
    phone: `+1816${selectionPhoneCounter}`,
    addressTag,
    contactName: { first, last },
    messages: [{ direction: "inbound", body: `${addressTag} selection body`, createdAtOffsetMin: -2, read: options.read ?? false }],
  });
}

async function latestInboundReadAt(thread: SeededThread): Promise<string | null> {
  const { data } = await admin
    .from("messages")
    .select("read_at")
    .eq("conversation_id", thread.threadId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.read_at ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
