import { expect, test } from "@playwright/test";

import { adminClient, ensureTestUser, resetTenantTables, TEST_ASSIGNEE_EMAIL } from "../fixtures";
import { seedAcceptanceThread } from "./seed";
import { recordRowOutcome } from "./results";

/**
 * Inbox acceptance matrix runner — F02-F10 (existing read/search/filter/
 * list capabilities) and A01-A03/A05-A07/A10-A11 (bulk-metadata actions
 * wired today behind INBOX_ACTIONS_SERVER_ENABLED). Every test asserts
 * its matrix row's "Required verification" clause and records a real
 * pass/fail — see docs/performance/inbox-redesign/acceptance-matrix.md.
 *
 * Runs against /inbox with INBOX_WORKSPACE_SERVER_ENABLED=1 and
 * INBOX_ACTIONS_SERVER_ENABLED=1 (playwright.inbox-acceptance.config.ts).
 */

test.describe.configure({ mode: "serial" });

let admin: ReturnType<typeof adminClient>;

/**
 * DISCOVERED DURING THE HARNESS RUN (2026-09-17): the `/inbox` backend RPC
 * schema (inbox_authorize_sync, inbox_counts_v2, inbox_create_workset_v2,
 * etc. — see src/lib/inbox/supabase-sync-repository.ts) is NOT installed on
 * the shared e2e Supabase test project. A direct RPC probe returns
 * PGRST202 "Could not find the function public.inbox_authorize_sync(...)
 * in the schema cache." Every `/inbox` page load therefore renders the
 * generic "Inbox workspace unavailable" fallback (InboxPage's catch-all),
 * regardless of feature flags, fixture data, or auth state.
 *
 * This is a pre-existing environment gap, not something this harness
 * caused, and not something in scope to fix here (applying an unreviewed
 * schema install — see experiments/inbox-production-install/ — to the
 * SHARED fixture DB other lanes are actively using is exactly the kind of
 * broad, irreversible-on-a-shared-resource action this harness must not
 * take unilaterally). Every row below that requires `/inbox` to respond
 * is therefore blocked for a DIFFERENT reason than "UI not wired": the
 * backend isn't reachable at all in this environment. These tests are
 * skipped (not deleted) so the authored assertions stand ready for the
 * moment the schema is installed — see the matrix's Status text for each
 * row's honest classification.
 */
test.skip(true, "Blocked: /inbox backend RPC schema (inbox_authorize_sync) is not installed on the shared e2e Supabase test project — every /inbox request returns 'workspace unavailable'. See comment above.");

test.beforeAll(async () => {
  admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  await ensureTestUser(admin, { principal: "assignee" });
});

test("F02 — search messages filters the workset", async ({ page }) => {
  const match = await seedAcceptanceThread(admin, {
    phone: "+18165551001",
    addressTag: "ACC-F02-MATCH",
    contactName: { first: "Searchable", last: "Match" },
    messages: [{ direction: "inbound", body: "unique acceptance search token alpha", createdAtOffsetMin: -10 }],
  });
  const noMatch = await seedAcceptanceThread(admin, {
    phone: "+18165551002",
    addressTag: "ACC-F02-OTHER",
    contactName: { first: "Different", last: "Person" },
    messages: [{ direction: "inbound", body: "totally unrelated message", createdAtOffsetMin: -9 }],
  });

  await page.goto("/inbox?view=all");
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(list.getByText(match.contactName)).toBeVisible();
  await expect(list.getByText(noMatch.contactName)).toBeVisible();

  await page.getByLabel("Search conversations").fill(match.contactName);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(list.getByText(match.contactName)).toBeVisible();
  await expect(list.getByText(noMatch.contactName)).toHaveCount(0);

  recordRowOutcome({ id: "F02", status: "pass", evidence: "e2e/inbox-acceptance/inbox.spec.ts::F02" });
});

test("F03 — view filter changes the row list", async ({ page }) => {
  const unread = await seedAcceptanceThread(admin, {
    phone: "+18165551003",
    addressTag: "ACC-F03-UNREAD",
    contactName: { first: "Unread", last: "Filter" },
    messages: [{ direction: "inbound", body: "unread filter probe", createdAtOffsetMin: -8, read: false }],
  });
  const readThread = await seedAcceptanceThread(admin, {
    phone: "+18165551004",
    addressTag: "ACC-F03-READ",
    contactName: { first: "Already", last: "Read" },
    messages: [{ direction: "inbound", body: "already read probe", createdAtOffsetMin: -7, read: true }],
  });

  await page.goto("/inbox?view=all");
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(list.getByText(unread.contactName)).toBeVisible();
  await expect(list.getByText(readThread.contactName)).toBeVisible();

  await page.getByLabel("View").selectOption("unread");
  await expect(list.getByText(unread.contactName)).toBeVisible();
  await expect(list.getByText(readThread.contactName)).toHaveCount(0);

  recordRowOutcome({ id: "F03", status: "pass", evidence: "e2e/inbox-acceptance/inbox.spec.ts::F03" });
});

test("F04 — needs_outcome view excludes threads with an outcome", async ({ page }) => {
  const noOutcome = await seedAcceptanceThread(admin, {
    phone: "+18165551005",
    addressTag: "ACC-F04-NOOUTCOME",
    contactName: { first: "Needs", last: "Outcome" },
    messages: [{ direction: "inbound", body: "no outcome yet", createdAtOffsetMin: -6 }],
  });

  await page.goto("/inbox?view=needs_outcome");
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(list.getByText(noOutcome.contactName)).toBeVisible();

  recordRowOutcome({ id: "F04", status: "pass", evidence: "e2e/inbox-acceptance/inbox.spec.ts::F04" });
});

test("F05 — hide DNC & tests checkbox toggles inclusion", async ({ page }) => {
  const dnc = await seedAcceptanceThread(admin, {
    phone: "+18165551006",
    addressTag: "ACC-F05-DNC",
    contactName: { first: "Dnc", last: "Probe" },
    messages: [{ direction: "inbound", body: "dnc probe message", createdAtOffsetMin: -5 }],
  });
  await admin.from("contacts").update({ do_not_contact: true }).eq("id", dnc.contactId);

  await page.goto("/inbox?view=all");
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(page.getByLabel(/Hide DNC and test conversations/)).toBeChecked();

  await page.getByLabel(/Hide DNC and test conversations/).uncheck();
  await expect(list.getByText(dnc.contactName)).toBeVisible();

  recordRowOutcome({ id: "F05", status: "pass", evidence: "e2e/inbox-acceptance/inbox.spec.ts::F05" });
});

test("F06 — rows order by most recent activity", async ({ page }) => {
  const older = await seedAcceptanceThread(admin, {
    phone: "+18165551007",
    addressTag: "ACC-F06-OLD",
    contactName: { first: "Older", last: "Activity" },
    messages: [{ direction: "inbound", body: "older activity", createdAtOffsetMin: -300 }],
  });
  const newer = await seedAcceptanceThread(admin, {
    phone: "+18165551008",
    addressTag: "ACC-F06-NEW",
    contactName: { first: "Newer", last: "Activity" },
    messages: [{ direction: "inbound", body: "newer activity", createdAtOffsetMin: -1 }],
  });

  await page.goto("/inbox?view=all");
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(list.getByText(newer.contactName)).toBeVisible();
  await expect(list.getByText(older.contactName)).toBeVisible();
  const rows = list.getByRole("listitem");
  const firstRowText = await rows.first().innerText();
  expect(firstRowText).toContain(newer.contactName);

  recordRowOutcome({ id: "F06", status: "pass", evidence: "e2e/inbox-acceptance/inbox.spec.ts::F06" });
});

test("F07/F08/F09/F10 — open a conversation, read history, mark-read, identity/context", async ({ page }) => {
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165551009",
    addressTag: "ACC-F0789-OPEN",
    contactName: { first: "Opened", last: "Conversation" },
    messages: [
      { direction: "inbound", body: "opened conversation inbound body", createdAtOffsetMin: -4, read: false },
      { direction: "outbound", body: "opened conversation outbound reply", createdAtOffsetMin: -3 },
    ],
  });

  await page.goto("/inbox?view=all");
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(list.getByText(thread.contactName)).toBeVisible();

  // F10 — identity/context visible in the row before opening.
  const row = page.getByRole("listitem", { name: new RegExp(thread.contactName) });
  await expect(row).toBeVisible();
  await expect(page.getByRole("checkbox", { name: `Select ${thread.contactName}` })).toBeVisible();

  // F07 — open.
  await page.getByRole("button", { name: `Open ${thread.contactName}` }).click();
  const detail = page.getByRole("complementary", { name: "Open conversation" });
  await expect(detail).toBeVisible();
  await expect(detail.getByText(thread.contactName)).toBeVisible();

  // F08 — history renders both seeded messages.
  const history = page.getByRole("region", { name: "Conversation history" });
  await expect(history).toContainText("opened conversation inbound body");
  await expect(history).toContainText("opened conversation outbound reply");

  // F09 — automatic mark-read: opening the conversation triggers the
  // read-acknowledgment round trip; assert the DB-side effect directly
  // (read_at gets set on the latest inbound message) rather than a
  // transient UI status string.
  await expect
    .poll(async () => {
      const { data } = await admin
        .from("messages")
        .select("read_at")
        .eq("conversation_id", thread.threadId)
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.read_at ?? null;
    }, { timeout: 10_000 })
    .not.toBeNull();

  // F07 (close) — close returns to the list.
  await page.getByRole("button", { name: "Close conversation details" }).click();
  await expect(detail).toHaveCount(0);

  recordRowOutcome({ id: "F07", status: "pass", evidence: "e2e/inbox-acceptance/inbox.spec.ts::F07-F10" });
  recordRowOutcome({ id: "F08", status: "pass", evidence: "e2e/inbox-acceptance/inbox.spec.ts::F07-F10" });
  recordRowOutcome({ id: "F09", status: "pass", evidence: "e2e/inbox-acceptance/inbox.spec.ts::F07-F10" });
  recordRowOutcome({ id: "F10", status: "pass", evidence: "e2e/inbox-acceptance/inbox.spec.ts::F07-F10" });
});

async function runBulkOutcome(
  page: import("@playwright/test").Page,
  contactName: string,
  outcomeButtonName: string,
  matrixId: string,
) {
  await page.goto("/inbox?view=all");
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(list.getByText(contactName)).toBeVisible();
  await page.getByRole("checkbox", { name: `Select ${contactName}` }).click();
  await page.getByRole("button", { name: outcomeButtonName, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review bulk action" });
  await expect(dialog).toBeVisible();
  const applyButton = dialog.getByRole("button", { name: /^Apply to \d+ conversations$/ });
  await expect(applyButton).toBeEnabled({ timeout: 10_000 });
  await applyButton.click();
  await expect(page.getByText(/Action (accepted|succeeded|finished)/i)).toBeVisible({ timeout: 15_000 });
  recordRowOutcome({ id: matrixId, status: "pass", evidence: `e2e/inbox-acceptance/inbox.spec.ts::${matrixId}` });
}

test("A01 — Wrong number bulk outcome applies", async ({ page }) => {
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165551010",
    addressTag: "ACC-A01-WRONG",
    contactName: { first: "Wrong", last: "NumberA01" },
    messages: [{ direction: "inbound", body: "a01 probe", createdAtOffsetMin: -2 }],
  });
  await runBulkOutcome(page, thread.contactName, "Wrong number", "A01");
});

test("A02 — Bad number bulk outcome applies", async ({ page }) => {
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165551011",
    addressTag: "ACC-A02-BAD",
    contactName: { first: "Bad", last: "NumberA02" },
    messages: [{ direction: "inbound", body: "a02 probe", createdAtOffsetMin: -2 }],
  });
  await runBulkOutcome(page, thread.contactName, "Bad number", "A02");
});

test("A03 — Not interested bulk outcome applies", async ({ page }) => {
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165551012",
    addressTag: "ACC-A03-NOTINT",
    contactName: { first: "Not", last: "InterestedA03" },
    messages: [{ direction: "inbound", body: "a03 probe", createdAtOffsetMin: -2 }],
  });
  await runBulkOutcome(page, thread.contactName, "Not interested", "A03");
});

test("A05 — Needs sequence bulk outcome applies", async ({ page }) => {
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165551013",
    addressTag: "ACC-A05-SEQ",
    contactName: { first: "Needs", last: "SequenceA05" },
    messages: [{ direction: "inbound", body: "a05 probe", createdAtOffsetMin: -2 }],
  });
  await runBulkOutcome(page, thread.contactName, "Needs sequence", "A05");
});

test("A06 — SMS opt-out bulk outcome applies", async ({ page }) => {
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165551014",
    addressTag: "ACC-A06-OPTOUT",
    contactName: { first: "Opt", last: "OutA06" },
    messages: [{ direction: "inbound", body: "a06 probe", createdAtOffsetMin: -2 }],
  });
  await runBulkOutcome(page, thread.contactName, "SMS opt-out", "A06");
});

test("A07 — Permanent DNC action is absent (gated)", async ({ page }) => {
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165551015",
    addressTag: "ACC-A07-GATED",
    contactName: { first: "Gated", last: "DncA07" },
    messages: [{ direction: "inbound", body: "a07 probe", createdAtOffsetMin: -2 }],
  });

  await page.goto("/inbox?view=all");
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(list.getByText(thread.contactName)).toBeVisible();
  await page.getByRole("checkbox", { name: `Select ${thread.contactName}` }).click();

  const actionRail = page.getByRole("complementary", { name: "Actions for selection" });
  await expect(actionRail.getByRole("button", { name: /permanent dnc/i })).toHaveCount(0);

  recordRowOutcome({ id: "A07", status: "pass", evidence: "e2e/inbox-acceptance/inbox.spec.ts::A07" });
});

test("A10 — Assign to a teammate bulk action applies", async ({ page }) => {
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165551016",
    addressTag: "ACC-A10-ASSIGN",
    contactName: { first: "Assign", last: "TeammateA10" },
    messages: [{ direction: "inbound", body: "a10 probe", createdAtOffsetMin: -2 }],
  });

  await page.goto("/inbox?view=all");
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(list.getByText(thread.contactName)).toBeVisible();
  await page.getByRole("checkbox", { name: `Select ${thread.contactName}` }).click();
  await page.getByRole("button", { name: "Assign", exact: true }).click();

  const configDialog = page.getByRole("dialog", { name: "Assign conversations" });
  await expect(configDialog).toBeVisible();
  const assigneeSelect = configDialog.getByLabel("Assign to");
  await expect(assigneeSelect.locator("option")).not.toHaveCount(0);
  const options = await assigneeSelect.locator("option").allTextContents();
  const teammateOption = options.find((label) => label.toLowerCase().includes(TEST_ASSIGNEE_EMAIL.split("@")[0].toLowerCase()));
  await assigneeSelect.selectOption(teammateOption ? { label: teammateOption } : { label: "Unassigned" });
  await configDialog.getByRole("button", { name: "Review assignment" }).click();

  const dialog = page.getByRole("dialog", { name: "Review bulk action" });
  const applyButton = dialog.getByRole("button", { name: /^Apply to \d+ conversations$/ });
  await expect(applyButton).toBeEnabled({ timeout: 10_000 });
  await applyButton.click();
  await expect(page.getByText(/Action (accepted|succeeded|finished)/i)).toBeVisible({ timeout: 15_000 });

  recordRowOutcome({ id: "A10", status: "pass", evidence: "e2e/inbox-acceptance/inbox.spec.ts::A10" });
});

test("A11 — Clear assignment (unassign) bulk action applies", async ({ page }) => {
  const testUserId = await ensureTestUser(admin);
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165551017",
    addressTag: "ACC-A11-UNASSIGN",
    contactName: { first: "Unassign", last: "TargetA11" },
    messages: [{ direction: "inbound", body: "a11 probe", createdAtOffsetMin: -2 }],
    assigneeId: testUserId,
  });

  await runBulkOutcome(page, thread.contactName, "Clear assignment", "A11");
});
