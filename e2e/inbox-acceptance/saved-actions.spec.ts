import { expect, test, type Page } from "./fixture";

import { adminClient, DEFAULT_ORG_ID, E2E_MOCK_BUSINESS_NUMBER, ensureTestUser } from "../fixtures";
import { seedSenderCatalog } from "../../tests/integration/delivery";
import { seedAcceptanceThread } from "./seed";
import { resetAcceptanceFixture } from "./cleanup";

/**
 * Saved actions are exercised through the authenticated browser boundary. The
 * CRUD assertions re-read the public route after the page has been refreshed,
 * so a local component state update cannot make an unpersisted row look real.
 * The combo assertion deliberately observes every route: metadata acceptance
 * must finish before the UI offers the separate reply review, and preparation
 * must never call reply accept/send on its own.
 *
 * This file is intentionally outside the acceptance matrix. It owns the
 * saved-action vertical slice and does not alter the shared matrix contract.
 */
test.describe.configure({ mode: "serial" });
test.skip(
  process.env.INBOX_ACCEPTANCE_RUN !== "1",
  "Use playwright.inbox-acceptance.config.ts for the owned saved-action fixture.",
);

type SavedDefinition = {
  version: 1;
  steps: Array<
    | { type: "outcome"; value: string }
    | { type: "assign"; userId: string | null }
    | { type: "promote" }
    | { type: "review_reply"; text: string }
  >;
};

type SavedRow = {
  id: string;
  version: number;
  name: string;
  definition: SavedDefinition;
  is_active?: boolean;
};

type BrowserJson = { status: number; data: unknown };

let admin: ReturnType<typeof adminClient>;
let assigneeId: string;

async function browserJson(
  page: Page,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  payload?: unknown,
): Promise<BrowserJson> {
  return page.evaluate(
    async ({ path: requestPath, method: requestMethod, payload: requestPayload }) => {
      const response = await fetch(requestPath, {
        method: requestMethod,
        credentials: "same-origin",
        cache: "no-store",
        headers: requestMethod === "GET" ? undefined : { "content-type": "application/json" },
        body: requestMethod === "GET" ? undefined : JSON.stringify(requestPayload),
      });
      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        // Keep the status available for a useful assertion below.
      }
      return { status: response.status, data };
    },
    { path, method, payload },
  );
}

async function savedRows(page: Page): Promise<SavedRow[]> {
  const response = await browserJson(page, "/api/inbox/saved-actions");
  expect(response.status, "authenticated saved-action list").toBe(200);
  const body = response.data as { items?: unknown };
  expect(Array.isArray(body.items), "saved-action list shape").toBe(true);
  return body.items as SavedRow[];
}

function responseFor(page: Page, path: string, method: string) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path &&
      response.request().method() === method,
  );
}

async function saveOutcomeAction(page: Page, name: string): Promise<SavedRow> {
  await page.getByRole("button", { name: "Create saved action", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create saved action" });
  await dialog.getByLabel("Saved action name").fill(name);
  const saveResponse = responseFor(page, "/api/inbox/saved-actions", "POST");
  await dialog.getByRole("button", { name: "Save action", exact: true }).click();
  expect((await saveResponse).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  const rows = await savedRows(page);
  const row = rows.find((candidate) => candidate.name === name);
  expect(row, "created saved action persisted in authenticated list").toBeDefined();
  return row as SavedRow;
}

test.beforeAll(async () => {
  admin = adminClient();
  await ensureTestUser(admin);
  assigneeId = await ensureTestUser(admin, { principal: "assignee" });
});

test.beforeEach(async () => {
  await resetAcceptanceFixture(admin);
  await ensureTestUser(admin);
});

test("saved action CRUD persists immutable edits and deactivation", async ({ page }) => {
  await page.goto("/inbox?view=all");
  await expect(page.getByRole("list", { name: "Inbox conversations" })).toBeVisible();

  const originalName = `E2E saved CRUD ${Date.now()}`;
  const created = await saveOutcomeAction(page, originalName);
  expect(created.version).toBe(1);
  expect(created.definition).toEqual({
    version: 1,
    steps: [{ type: "outcome", value: "nurture" }],
  });

  const editedName = `${originalName} edited`;
  await page.getByRole("button", { name: "Create saved action", exact: true }).click();
  const editLauncher = page.getByRole("dialog", { name: "Create saved action" });
  const existing = editLauncher.locator("li").filter({ hasText: originalName });
  await expect(existing).toBeVisible();
  await existing.getByRole("button", { name: "Edit", exact: true }).click();

  const editDialog = page.getByRole("dialog", { name: "Edit saved action" });
  await editDialog.getByLabel("Saved action name").fill(editedName);
  await editDialog.getByLabel("Step 1 outcome").selectOption("not_interested");
  const patchResponse = responseFor(page, "/api/inbox/saved-actions", "PATCH");
  await editDialog.getByRole("button", { name: "Save changes", exact: true }).click();
  expect((await patchResponse).status()).toBe(200);
  await expect(editDialog).toHaveCount(0);

  // Re-read after the edit; the expected version and definition must come from
  // the server's immutable version chain, not from the editor's React state.
  const editedRows = await savedRows(page);
  const edited = editedRows.find((candidate) => candidate.id === created.id);
  expect(edited).toMatchObject({
    id: created.id,
    version: 2,
    name: editedName,
    definition: {
      version: 1,
      steps: [{ type: "outcome", value: "not_interested" }],
    },
  });

  await page.getByRole("button", { name: "Create saved action", exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  const deleteResponse = responseFor(page, "/api/inbox/saved-actions", "DELETE");
  const deleteDialog = page.getByRole("dialog", { name: "Create saved action" });
  const editedRow = deleteDialog.locator("li").filter({ hasText: editedName });
  await expect(editedRow).toBeVisible();
  await editedRow.getByRole("button", { name: "Delete", exact: true }).click();
  expect((await deleteResponse).status()).toBe(200);

  await expect
    .poll(async () => (await savedRows(page)).some((candidate) => candidate.id === created.id))
    .toBe(false);

  // A full navigation exercises the persisted tombstone again, and prevents a
  // stale in-memory list from satisfying the deactivation assertion.
  await page.reload();
  await expect(page.getByRole("list", { name: "Inbox conversations" })).toBeVisible();
  expect((await savedRows(page)).some((candidate) => candidate.id === created.id)).toBe(false);
});

test("metadata combo offers a separately reviewed reply and never auto-accepts it", async ({ page }) => {
  await seedSenderCatalog(admin, DEFAULT_ORG_ID, [E2E_MOCK_BUSINESS_NUMBER], { provider: "sendillo" });
  const thread = await seedAcceptanceThread(admin, {
    phone: "+18165552001",
    businessNumber: E2E_MOCK_BUSINESS_NUMBER,
    propertyState: process.env.INBOX_ACCEPTANCE_REPLY_STATE ?? "MO",
    addressTag: `ACC-SAVED-COMBO-${Date.now()}`,
    contactName: { first: "Saved", last: "Combo" },
    propertyStatus: "prospect",
    messages: [
      {
        direction: "inbound",
        body: "Could you send the details?",
        createdAtOffsetMin: -2,
      },
    ],
  });
  const { error: consentError } = await admin.from("consent_events").insert({
    contact_id: thread.contactId,
    channel: "sms",
    event_type: "opt_in_marketing_written",
    source: "e2e-saved-actions",
  });
  expect(consentError).toBeNull();

  await page.goto("/inbox?view=all");
  await expect(page.getByRole("list", { name: "Inbox conversations" }).getByText(thread.contactName)).toBeVisible();

  const comboName = `E2E metadata reply ${Date.now()}`;
  await page.getByRole("button", { name: "Create saved action", exact: true }).click();
  const builder = page.getByRole("dialog", { name: "Create saved action" });
  await builder.getByLabel("Saved action name").fill(comboName);

  // Outcome -> Promote -> Assign is the ordinary durable metadata prefix.
  await builder.getByRole("button", { name: "Add step", exact: true }).click();
  await builder.getByLabel("Step 2 type").selectOption("promote");
  await builder.getByRole("button", { name: "Add step", exact: true }).click();
  await builder.getByLabel("Step 3 type").selectOption("assign");
  await expect
    .poll(async () => builder.getByLabel("Step 3 assignee").locator("option").count())
    .toBeGreaterThan(1);
  await builder.getByLabel("Step 3 assignee").selectOption(assigneeId);
  await builder.getByRole("button", { name: "Add step", exact: true }).click();
  await builder.getByLabel("Step 4 type").selectOption("review_reply");
  await builder
    .getByLabel("Step 4 reply text")
    .fill("Hi {{first_name}}, details for {{property_address}}. - {{my_first_name}}");

  const comboSaveResponse = responseFor(page, "/api/inbox/saved-actions", "POST");
  await builder.getByRole("button", { name: "Save action", exact: true }).click();
  expect((await comboSaveResponse).status()).toBe(200);
  await expect(builder).toHaveCount(0);

  // The open review dialog makes background roles inaccessible; the labeled
  // checkbox still proves the original selection is retained.
  const selection = page.getByLabel(`Select ${thread.contactName}`, { exact: true });
  await selection.check();
  await expect(selection).toBeChecked();
  await expect(page.getByRole("region", { name: "Conversation selection", includeHidden: true }).getByText("1 selected", { exact: true })).toBeVisible();

  const picker = page.getByLabel("Saved actions");
  await expect(picker.getByRole("option", { name: comboName, exact: true })).toHaveCount(1);
  await picker.getByLabel("Saved action").selectOption({ label: comboName });

  const replyAcceptRequests: string[] = [];
  const replyAcceptListener = (request: import("@playwright/test").Request) => {
    if (new URL(request.url()).pathname === "/api/inbox/replies/accept") replyAcceptRequests.push(request.url());
  };
  page.on("request", replyAcceptListener);

  const prepareResponse = responseFor(page, "/api/inbox/actions/prepare", "POST");
  // The click starts the fetch before the dialog is populated; wait on the
  // response separately so this test proves the authenticated HTTP route ran.
  await picker.getByRole("button", { name: "Review saved action", exact: true }).click();
  expect((await prepareResponse).status()).toBe(200);
  const review = page.getByRole("dialog", { name: `Review saved action · ${comboName}` });
  await expect(review).toContainText("1 eligible · 0 excluded · 3 changes");
  expect(replyAcceptRequests).toHaveLength(0);

  const metadataAccept = responseFor(page, "/api/inbox/actions/accept", "POST");
  await review.getByRole("button", { name: "Accept reviewed action", exact: true }).click();
  expect((await metadataAccept).status()).toBe(200);
  expect(replyAcceptRequests).toHaveLength(0);

  await expect
    .poll(async () => {
      const { data, error } = await admin
        .from("properties")
        .select("status, outreach_dispo, assigned_user_id")
        .eq("id", thread.propertyId)
        .maybeSingle();
      expect(error).toBeNull();
      return data;
    })
    .toMatchObject({ status: "new_lead", outreach_dispo: "nurture", assigned_user_id: assigneeId });

  const metadataResults = review.getByRole("region", { name: "Saved action results" });
  await expect(metadataResults).toBeVisible({ timeout: 20_000 });
  await expect(metadataResults).toContainText(`${thread.contactName}: succeeded`);

  // The accepted metadata operation retains the original selection and only
  // then exposes the explicit reply hand-off. No reply acceptance has happened.
  await expect(review.getByRole("button", { name: "Review reply", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(selection).toBeChecked();
  await expect(page.getByRole("region", { name: "Conversation selection", includeHidden: true }).getByText("1 selected", { exact: true })).toBeVisible();

  const replyPrepare = responseFor(page, "/api/inbox/replies/prepare", "POST");
  await review.getByRole("button", { name: "Review reply", exact: true }).click();
  expect((await replyPrepare).status()).toBe(200);
  const followUp = review.getByRole("region", { name: "Review saved reply" });
  await expect(followUp).toBeVisible();
  await expect(followUp).toContainText("Ready for send to Saved Combo");
  await expect(followUp).toContainText("Hi Saved");
  expect(replyAcceptRequests).toHaveLength(0);

  // Verify no provider-facing outbound row exists before the operator's
  // explicit reviewed-reply acceptance.
  const { data: outboundBeforeAccept, error: outboundError } = await admin
    .from("messages")
    .select("id")
    .eq("property_id", thread.propertyId)
    .eq("direction", "outbound");
  expect(outboundError).toBeNull();
  expect(outboundBeforeAccept ?? []).toHaveLength(0);

  const replyAccept = responseFor(page, "/api/inbox/replies/accept", "POST");
  await followUp.getByRole("button", { name: "Accept reviewed reply", exact: true }).click();
  const replyAcceptResponse = await replyAccept;
  expect(replyAcceptResponse.status()).toBe(200);
  expect(replyAcceptRequests).toHaveLength(1);
  const accepted = (await replyAcceptResponse.json()) as { operationId?: string };
  expect(accepted.operationId).toMatch(/^[0-9a-f-]{36}$/i);

  // The status receipt is also read through the authenticated browser API. It
  // proves the accept persisted an operation while keeping provider dispatch
  // outside this acceptance assertion.
  await expect
    .poll(async () => {
      const status = await browserJson(page, `/api/inbox/replies/${accepted.operationId}`);
      if (status.status !== 200) return false;
      const body = status.data as { operationId?: string; receipts?: unknown[] };
      return body.operationId === accepted.operationId && Array.isArray(body.receipts);
    })
    .toBe(true);

  page.off("request", replyAcceptListener);
});
