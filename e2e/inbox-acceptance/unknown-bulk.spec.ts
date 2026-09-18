import { expect, test, type Page } from "./fixture";
import { resetAcceptanceFixture } from "./cleanup";

import {
  adminClient,
  DEFAULT_ORG_ID,
  ensureTestUser,
} from "../fixtures";
import {
  captureRowEvidence,
  purgeRowOutcomes,
  readMatrixResults,
  recordRowOutcome,
} from "./results";

/**
 * U05/U06 are deliberately exercised through the authenticated Inbox UI.
 * The service client only creates the unknown inbound rows and verifies the
 * committed message state. The tests insert a same-sender arrival after the
 * authenticated prepare response but before accept, so a raw-sender-wide
 * UPDATE would fail the exact-scope assertions.
 *
 * Runtime is opt-in because the acceptance harness requires the coordinator's
 * installed Inbox RPC schema and isolated fixture. Keep this guard as the
 * only execution gate; a skipped run is not evidence of a pass.
 */
const shouldRun = process.env.INBOX_ACCEPTANCE_RUN === "1";

type UnknownSeed = { fromAddress: string; messageIds: string[] };
type MessageState = { id: string; dismissed_at: string | null };

const ROW_OWNERSHIP: Record<string, string[]> = {
  "U05 — bulk dismisses only the prepared unknown-message snapshot": ["U05"],
  "U06 — bulk restores only the prepared unknown-message snapshot": ["U06"],
};

let admin: ReturnType<typeof adminClient>;

test.describe.serial("Inbox individual unknown workflows", () => {
  test.skip(
    !shouldRun,
    "Runtime-unproven: set INBOX_ACCEPTANCE_RUN=1 through the dedicated acceptance config after coordinator runtime handoff.",
  );

  test.beforeAll(async () => {
    admin = adminClient();
    await resetAcceptanceFixture(admin);
    await ensureTestUser(admin);
  });

  test.beforeEach(async ({}, testInfo) => {
    purgeRowOutcomes(ROW_OWNERSHIP[testInfo.title] ?? []);
    await resetAcceptanceFixture(admin);
    await ensureTestUser(admin);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (!shouldRun) return;
    const ids = ROW_OWNERSHIP[testInfo.title] ?? [];
    const alreadyRecorded = new Set(readMatrixResults().map((result) => result.id));
    for (const id of ids) {
      if (alreadyRecorded.has(id)) continue;
      if (testInfo.status === "passed") {
        try {
          recordRowOutcome({ id, status: "pass", evidence: await captureRowEvidence(page, id) });
        } catch (error) {
          const detail = error instanceof Error ? error.message.slice(0, 300) : "evidence capture failed";
          recordRowOutcome({ id, status: "fail", evidence: `evidence capture failed: ${detail}` });
        }
      } else {
        const detail = testInfo.error?.message?.slice(0, 300) ?? "no assertion for this row completed";
        recordRowOutcome({ id, status: "fail", evidence: `test ${testInfo.status ?? "failed"}: ${detail}` });
      }
    }
  });

  test("U05 — bulk dismisses only the prepared unknown-message snapshot", async ({ page }) => {
    const initial = await seedUnknownSender("+18165559305", ["U05 captured one", "U05 captured two"]);
    const requestPaths: string[] = [];
    const requestListener = (request: import("@playwright/test").Request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/api/inbox/replies/")) requestPaths.push(pathname);
    };
    page.on("request", requestListener);

    const dialog = await prepareUnknownAction(page, initial.fromAddress, "unknown", "Dismiss unknown");

    // This row arrives after prepare has frozen the exact message IDs. A
    // sender-wide UPDATE would incorrectly dismiss it along with the capture.
    const later = await insertUnknownMessage(initial.fromAddress, "U05 later arrival");
    const beforeAccept = await messageStates([...initial.messageIds, later]);
    expect(beforeAccept).toEqual(expect.arrayContaining(initial.messageIds.map((id) => ({ id, dismissed_at: null }))));
    expect(beforeAccept.find((row) => row.id === later)?.dismissed_at).toBeNull();

    await acceptReviewedUnknownAction(page, dialog);

    const afterAccept = await messageStates([...initial.messageIds, later]);
    expect(afterAccept).toEqual(expect.arrayContaining(initial.messageIds.map((id) => ({ id, dismissed_at: expect.any(String) }))));
    expect(afterAccept.find((row) => row.id === later)?.dismissed_at).toBeNull();
    await expectNoAutomaticReply(initial.fromAddress, requestPaths);
    page.off("request", requestListener);
  });

  test("U06 — bulk restores only the prepared unknown-message snapshot", async ({ page }) => {
    const initial = await seedUnknownSender("+18165559306", ["U06 captured one", "U06 captured two"], true);
    const requestPaths: string[] = [];
    const requestListener = (request: import("@playwright/test").Request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/api/inbox/replies/")) requestPaths.push(pathname);
    };
    page.on("request", requestListener);

    const dialog = await prepareUnknownAction(page, initial.fromAddress, "dismissed", "Restore unknown");

    // Use a later row that is already dismissed so a broad raw-sender restore
    // is observable. It is outside the prepared message-id set and must stay
    // dismissed after the accepted operation.
    const later = await insertUnknownMessage(initial.fromAddress, "U06 later dismissed arrival", true);
    const beforeAccept = await messageStates([...initial.messageIds, later]);
    expect(beforeAccept).toEqual(expect.arrayContaining(initial.messageIds.map((id) => ({ id, dismissed_at: expect.any(String) }))));
    expect(beforeAccept.find((row) => row.id === later)?.dismissed_at).toEqual(expect.any(String));

    await acceptReviewedUnknownAction(page, dialog);

    const afterAccept = await messageStates([...initial.messageIds, later]);
    expect(afterAccept).toEqual(expect.arrayContaining(initial.messageIds.map((id) => ({ id, dismissed_at: null }))));
    expect(afterAccept.find((row) => row.id === later)?.dismissed_at).toEqual(expect.any(String));
    await expectNoAutomaticReply(initial.fromAddress, requestPaths);
    page.off("request", requestListener);
  });
});

async function prepareUnknownAction(
  page: Page,
  fromAddress: string,
  view: "unknown" | "dismissed",
  action: "Dismiss unknown" | "Restore unknown",
) {
  await page.goto(`/inbox?view=${view}`);
  const list = page.getByRole("list", { name: "Inbox conversations" });
  const row = list.getByRole("listitem").filter({ hasText: fromAddress }).first();
  await expect(row).toBeVisible();
  await row.getByRole("checkbox", { name: `Select ${fromAddress}` }).check();
  await expect(page.getByText("1 selected", { exact: false }).first()).toBeVisible();

  const prepareResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/inbox/actions/prepare" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: action, exact: true }).click();
  expect((await prepareResponse).status()).toBe(200);

  const dialog = page.getByRole("dialog", { name: "Review bulk action" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(action);
  await expect(dialog.getByRole("button", { name: /^Apply to 1 conversations$/ })).toBeEnabled();
  return dialog;
}

async function acceptReviewedUnknownAction(page: Page, dialog: ReturnType<Page["getByRole"]>) {
  const acceptResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/inbox/actions/accept" &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: /^Apply to 1 conversations$/ }).click();
  const response = await acceptResponse;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { operationId?: unknown };
  expect(body.operationId).toEqual(expect.any(String));
  await expect(page.getByRole("region", { name: "Bulk action progress" })).toContainText(
    /Action (succeeded|partial|failed|cancelled|finished)/i,
    { timeout: 20_000 },
  );
}

async function seedUnknownSender(
  fromAddress: string,
  bodies: readonly string[],
  dismissed = false,
): Promise<UnknownSeed> {
  const messageIds: string[] = [];
  for (const [index, body] of bodies.entries()) {
    messageIds.push(await insertUnknownMessage(fromAddress, body, dismissed, index));
  }
  return { fromAddress, messageIds };
}

async function insertUnknownMessage(
  fromAddress: string,
  body: string,
  dismissed = false,
  offsetSeconds = 0,
): Promise<string> {
  const { data, error } = await admin
    .from("messages")
    .insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
      contact_id: null,
      property_id: null,
      from_address: fromAddress,
      to_address: "+18162804181",
      body,
      created_at: new Date(Date.now() + offsetSeconds * 1000).toISOString(),
      dismissed_at: dismissed ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  expect(data?.id).toEqual(expect.any(String));
  return data!.id;
}

async function messageStates(ids: readonly string[]): Promise<MessageState[]> {
  const { data, error } = await admin.from("messages").select("id, dismissed_at").in("id", ids);
  expect(error).toBeNull();
  expect(new Set((data ?? []).map((row) => row.id))).toEqual(new Set(ids));
  return (data ?? []) as MessageState[];
}

async function expectNoAutomaticReply(fromAddress: string, requestPaths: readonly string[]) {
  expect(requestPaths).toEqual([]);
  const { data, error } = await admin
    .from("messages")
    .select("id")
    .eq("org_id", DEFAULT_ORG_ID)
    .eq("direction", "outbound")
    .eq("to_address", fromAddress);
  expect(error).toBeNull();
  expect(data ?? []).toHaveLength(0);
}
