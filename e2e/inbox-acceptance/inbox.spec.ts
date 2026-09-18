import { expect, test } from "./fixture";
import { resetAcceptanceFixture } from "./cleanup";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

import { adminClient, DEFAULT_ORG_ID, ensureTestUser } from "../fixtures";
import { seedAcceptanceThread } from "./seed";
import { captureRowEvidence, purgeRowOutcomes, recordRowOutcome } from "./results";
import { assertDisposableE2EDatabaseEnvironment } from "../../src/lib/supabase/e2e-target-safety";

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

// The ordinary golden suite does not enable the new workspace. Required
// Inbox acceptance runs in the dedicated owned-fixture config below.
test.skip(process.env.INBOX_ACCEPTANCE_RUN !== "1", "Use playwright.inbox-acceptance.config.ts for required Inbox acceptance");

function ownedRows(title: string): string[] {
  return title.split(" — ")[0].split("/").filter(id => /^[FARUO]\d{2}$/.test(id));
}
test.beforeEach(async ({}, info) => {
  // Every row owns its fixture. In particular, F06 intentionally creates 501
  // conversations to exercise pagination; carrying that projection into later
  // action rows makes their transport/recovery behavior depend on test order.
  await resetAcceptanceFixture(admin);
  await ensureTestUser(admin);
  purgeRowOutcomes(ownedRows(info.title));
});
test.afterEach(async ({ page }, info) => {
  const ids = ownedRows(info.title);
  purgeRowOutcomes(ids);
  for (const id of ids) {
    const passed = info.status === "passed";
    recordRowOutcome({ id, status: passed ? "pass" : info.status === "skipped" ? "skip" : "fail",
      evidence: passed ? await captureRowEvidence(page, id) : info.error?.message ?? `Test ${info.status}` });
  }
});

test.beforeAll(async () => {
  admin = adminClient();
  await resetAcceptanceFixture(admin);
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
  await page.getByRole("button", { name: "Search", exact: true }).click();
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
  await expect(list.getByText(unread.contactName, { exact: true })).toBeVisible();
  await expect(list.getByText(readThread.contactName, { exact: true })).toBeVisible();

  await page.getByLabel("View").selectOption("unread");
  await expect(list.getByText(unread.contactName, { exact: true })).toBeVisible();
  await expect(list.getByText(readThread.contactName, { exact: true })).toHaveCount(0);

  recordRowOutcome({ id: "F03", status: "pass", evidence: "e2e/inbox-acceptance/inbox.spec.ts::F03" });
});

test("F04 — needs_outcome view excludes threads with an outcome", async ({ page }) => {
  const noOutcome = await seedAcceptanceThread(admin, {
    phone: "+18165551005",
    addressTag: "ACC-F04-NOOUTCOME",
    contactName: { first: "Needs", last: "Outcome" },
    messages: [{ direction: "inbound", body: "no outcome yet", createdAtOffsetMin: -6 }],
  });

  const completed = await seedAcceptanceThread(admin, {
    phone: "+18165551904", addressTag: "ACC-F04-COMPLETED",
    contactName: { first: "Completed", last: "Outcome" },
    messages: [{ direction: "inbound", body: "outcome already recorded", createdAtOffsetMin: -6 }],
  });
  const { error } = await admin.from("properties").update({ outreach_dispo: "not_interested" }).eq("id", completed.propertyId);
  expect(error).toBeNull();
  await page.goto("/inbox?view=all");
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(list.getByText(completed.contactName)).toBeVisible();
  await page.getByLabel("View").selectOption("needs_outcome");
  await expect(list.getByText(noOutcome.contactName)).toBeVisible();
  await expect(list.getByText(completed.contactName)).toHaveCount(0);

  recordRowOutcome({ id: "F04", status: "pass", evidence: "e2e/inbox-acceptance/inbox.spec.ts::F04" });
});

test("F05 — hide DNC & tests checkbox toggles inclusion", async ({ page }) => {
  const dncPhone = `+1816${[...randomUUID().replaceAll("-", "").slice(0, 7)]
    .map((digit) => (Number.parseInt(digit, 16) % 10).toString())
    .join("")}`;
  const dnc = await seedAcceptanceThread(admin, {
    phone: dncPhone,
    addressTag: "ACC-F05-DNC",
    contactName: { first: "Dnc", last: "Probe" },
    messages: [{ direction: "inbound", body: "dnc probe message", createdAtOffsetMin: -5 }],
  });
  await admin.from("contacts").update({ do_not_contact: true }).eq("id", dnc.contactId);

  await page.goto("/inbox?view=all");
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(page.getByLabel(/Hide DNC and test conversations/)).toBeChecked();
  await expect(page.getByText(/\d+ loaded$/, { exact: false })).toBeVisible({ timeout: 20_000 });
  // The default projection must exclude the DNC conversation before the
  // operator changes the noise filter. Merely proving re-inclusion after the
  // toggle would allow a backend that ignores the default hide policy.
  await expect(list.getByText(dnc.contactName, { exact: true })).toHaveCount(0);

  await page.getByLabel(/Hide DNC and test conversations/).click();
  await expect(page.getByLabel(/Hide DNC and test conversations/)).not.toBeChecked();
  await expect(list.getByText(dnc.contactName, { exact: true })).toBeVisible();

  recordRowOutcome({ id: "F05", status: "pass", evidence: "e2e/inbox-acceptance/inbox.spec.ts::F05" });
});

async function seedOrderedInboxPage(count: number): Promise<{ newestName: string; oldestName: string }> {
  const now = Date.now();
  const contacts = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    first_name: "Page",
    last_name: `F06-${String(index).padStart(3, "0")}`,
    phone_1: `+1816556${String(1000 + index).padStart(4, "0")}`,
    phone_1_type: "mobile",
  }));
  const { error: contactError } = await admin.from("contacts").insert(contacts);
  expect(contactError).toBeNull();

  const properties = contacts.map((contact, index) => ({
    id: randomUUID(),
    address: `ACC-F06-${String(index).padStart(3, "0")} PAGE`,
    state: "MO",
    status: "new_lead",
    cass_status: "verified",
    city: "Kansas City",
    zip: "64151",
    market: "Kansas City",
    homeowner_contact_id: contact.id,
  }));
  const { error: propertyError } = await admin.from("properties").insert(properties);
  expect(propertyError).toBeNull();

  const messages = properties.map((property, index) => ({
    id: randomUUID(),
    channel: "sms",
    direction: "inbound",
    status: "received",
    conversation_id: randomUUID(),
    contact_id: contacts[index].id,
    property_id: property.id,
    from_address: contacts[index].phone_1,
    to_address: "+18162804181",
    body: `ordered activity ${String(index).padStart(3, "0")}`,
    created_at: new Date(now - index * 60_000).toISOString(),
  }));
  const { error: messageError } = await admin.from("messages").insert(messages);
  expect(messageError).toBeNull();

  return {
    newestName: "Page F06-000",
    oldestName: `Page F06-${String(count - 1).padStart(3, "0")}`,
  };
}

/**
 * Workset creation snapshots the maintained projection, not the canonical
 * source tables. The bulk F06 seed intentionally exercises the 500-row page
 * boundary, so wait for the exact page predicate to be projected before
 * creating the scope. This is a read-only disposable-fixture probe; without
 * it, the first workset can legitimately freeze a partially projected page.
 */
async function waitForOrderedProjection(expectedCount: number): Promise<void> {
  const databaseUrl = process.env.E2E_CI_SUPABASE_DB_URL;
  if (process.env.E2E_DISPOSABLE_DATABASE !== "1" || databaseUrl !== "postgresql://postgres:postgres@127.0.0.1:54322/postgres") {
    throw new Error("F06 projection readiness requires the exact disposable loopback database.");
  }
  assertDisposableE2EDatabaseEnvironment(process.env.TEST_SUPABASE_URL ?? "", {
    ...process.env,
    E2E_CI_SUPABASE_DB_URL: databaseUrl,
  });

  const client = new Client({ connectionString: databaseUrl, ssl: false });
  await client.connect();
  try {
    const identity = await client.query<{ marker: string | null }>(
      "SELECT marker FROM install_fixture.identity LIMIT 1",
    );
    if (identity.rows[0]?.marker !== "sandra-inbox-http-owned-synthetic-20260917") {
      throw new Error("F06 projection readiness database identity marker mismatch.");
    }

    await expect.poll(async () => {
      await client.query("BEGIN READ ONLY");
      try {
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM inbox_bridge.filter_rows
            WHERE org_id = $1::uuid
              AND target_kind = 'known_conversation'
              AND has_recent
              AND NOT is_noise`,
          [DEFAULT_ORG_ID],
        );
        await client.query("COMMIT");
        return Number(result.rows[0]?.count ?? -1);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }, { timeout: 20_000, intervals: [250, 500, 1_000, 2_000] }).toBe(expectedCount);
  } finally {
    await client.end();
  }
}

test("F06 — rows order by most recent activity", async ({ page }) => {
  // Isolate the page-boundary proof from earlier serial rows. The fixture is
  // inserted in two bounded service-role batches plus one message batch;
  // there are no 500 browser actions and no provider calls.
  const { newestName, oldestName } = await seedOrderedInboxPage(501);
  await waitForOrderedProjection(501);

  await page.goto("/inbox?view=all");
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(page.getByText("500 loaded", { exact: true })).toBeVisible({ timeout: 20_000 });
  const rows = list.getByRole("listitem");
  await expect(rows.first()).toContainText(newestName);

  const nextPage = page.getByRole("button", { name: "Next 500", exact: true });
  await expect(nextPage).toBeEnabled();
  await nextPage.click();
  await expect(page.getByText("1 loaded", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(nextPage).toBeDisabled();
  await expect(list.getByText(oldestName)).toBeVisible();
  await expect(rows.first()).toContainText(oldestName);
  await expect(list.getByText(newestName)).toHaveCount(0);

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
  await expect(list.getByText(thread.contactName, { exact: true })).toBeVisible();

  // F10 — identity/context visible in the row before opening.
  const row = page.getByRole("listitem", { name: new RegExp(thread.contactName) });
  await expect(row).toBeVisible();
  await expect(page.getByRole("checkbox", { name: `Select ${thread.contactName}` })).toBeVisible();

  // F07 — open.
  await page.getByRole("button", { name: `Open ${thread.contactName}` }).click();
  const detail = page.getByRole("complementary", { name: "Open conversation" });
  await expect(detail).toBeVisible();
  await expect(detail.getByText(thread.contactName, { exact: true })).toBeVisible();

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
  propertyId: string,
  expected: { outreach_dispo?: string; assigned_user_id?: string | null },
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
  await expect(async () => {
    const { data, error } = await admin.from("properties").select("outreach_dispo, assigned_user_id").eq("id", propertyId).single();
    expect(error).toBeNull();
    expect(data).toMatchObject(expected);
  }).toPass({ timeout: 15_000 });
  recordRowOutcome({ id: matrixId, status: "pass", evidence: `e2e/inbox-acceptance/inbox.spec.ts::${matrixId}` });
}

test("A01 — Wrong number bulk outcome applies", async ({ page }) => {
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165551010",
    addressTag: "ACC-A01-WRONG",
    contactName: { first: "Wrong", last: "NumberA01" },
    messages: [{ direction: "inbound", body: "a01 probe", createdAtOffsetMin: -2 }],
  });
  await runBulkOutcome(page, thread.contactName, "Wrong number", "A01", thread.propertyId, { outreach_dispo: "wrong_number" });
});

test("A02 — Bad number bulk outcome applies", async ({ page }) => {
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165551011",
    addressTag: "ACC-A02-BAD",
    contactName: { first: "Bad", last: "NumberA02" },
    messages: [{ direction: "inbound", body: "a02 probe", createdAtOffsetMin: -2 }],
  });
  await runBulkOutcome(page, thread.contactName, "Bad number", "A02", thread.propertyId, { outreach_dispo: "bad_number" });
});

test("A03 — Not interested bulk outcome applies", async ({ page }) => {
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165551012",
    addressTag: "ACC-A03-NOTINT",
    contactName: { first: "Not", last: "InterestedA03" },
    messages: [{ direction: "inbound", body: "a03 probe", createdAtOffsetMin: -2 }],
  });
  await runBulkOutcome(page, thread.contactName, "Not interested", "A03", thread.propertyId, { outreach_dispo: "not_interested" });
});

test("A05 — Needs sequence bulk outcome applies", async ({ page }) => {
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165551013",
    addressTag: "ACC-A05-SEQ",
    contactName: { first: "Needs", last: "SequenceA05" },
    messages: [{ direction: "inbound", body: "a05 probe", createdAtOffsetMin: -2 }],
  });
  await runBulkOutcome(page, thread.contactName, "Needs sequence", "A05", thread.propertyId, { outreach_dispo: "needs_sequence" });
});

test("A06 — SMS opt-out bulk outcome applies", async ({ page }) => {
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165551014",
    addressTag: "ACC-A06-OPTOUT",
    contactName: { first: "Opt", last: "OutA06" },
    messages: [{ direction: "inbound", body: "a06 probe", createdAtOffsetMin: -2 }],
  });
  await runBulkOutcome(page, thread.contactName, "SMS opt-out", "A06", thread.propertyId, { outreach_dispo: "opted_out" });
  await expect(async () => {
    const { data, error } = await admin.from("contacts").select("sms_opted_out").eq("id", thread.contactId).single();
    expect(error).toBeNull(); expect(data?.sms_opted_out).toBe(true);
  }).toPass({ timeout: 15_000 });
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
  const teammateId = await ensureTestUser(admin, { principal: "assignee" });
  await assigneeSelect.selectOption(teammateId);
  await configDialog.getByRole("button", { name: "Review assignment" }).click();

  const dialog = page.getByRole("dialog", { name: "Review bulk action" });
  const applyButton = dialog.getByRole("button", { name: /^Apply to \d+ conversations$/ });
  await expect(applyButton).toBeEnabled({ timeout: 10_000 });
  await applyButton.click();
  await expect(page.getByText(/Action (accepted|succeeded|finished)/i)).toBeVisible({ timeout: 15_000 });

  await expect(async () => {
    const { data, error } = await admin.from("properties").select("assigned_user_id").eq("id", thread.propertyId).single();
    expect(error).toBeNull(); expect(data?.assigned_user_id).toBe(teammateId);
  }).toPass({ timeout: 15_000 });
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

  await runBulkOutcome(page, thread.contactName, "Clear assignment", "A11", thread.propertyId, { assigned_user_id: null });
});
