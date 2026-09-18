import { expect, test, type Page, type Request } from "./fixture";
import { resetAcceptanceFixture } from "./cleanup";

import {
  adminClient,
  DEFAULT_ORG_ID,
  E2E_MOCK_BUSINESS_NUMBER,
  ensureTestUser,
} from "../fixtures";
import { seedSenderCatalog } from "../../tests/integration/delivery";
import {
  captureRowEvidence,
  purgeRowOutcomes,
  readMatrixResults,
  recordRowOutcome,
} from "./results";
import { seedAcceptanceThread, type SeededThread } from "./seed";

/**
 * R01-R05 exercise the reviewed-reply composer in the new Inbox. The browser
 * uses the authenticated HTTP routes and the service client is used only to
 * create consent/template fixtures and verify durable results. Nothing here
 * calls a provider or substitutes a mocked RPC response.
 *
 * This suite is deliberately opt-in. The ordinary acceptance config must keep
 * the matrix rows at their existing blocked status until a coordinator hands
 * off a database with the Inbox reply functions installed.
 */

const shouldRun = process.env.INBOX_ACCEPTANCE_RUN === "1";

const ROW_OWNERSHIP: Record<string, string[]> = {
  "R01 — write and edit a reviewed reply": ["R01"],
  "R02 — insert a template into a reviewed reply": ["R02"],
  "R03 — Cmd/Ctrl+Enter opens review without acceptance": ["R03"],
  "R04 — explicit acceptance uses the conversation reply route": ["R04"],
  "R05 — restriction and route changes refuse the old review": ["R05"],
};

type BrowserJson = { status: number; data: unknown };

let admin: ReturnType<typeof adminClient>;
let templateIds: string[] = [];
let phoneCounter = 0;

async function browserJson(
  page: Page,
  path: string,
  method: "GET" | "POST" = "GET",
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

function responseFor(page: Page, path: string, method: string) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path &&
      response.request().method() === method,
  );
}

function auditRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/inbox/replies/")) requests.push(request);
    // Keep the legacy action route visible in the same audit. A review must
    // never fall through to sendSmsFromLead or any other provider-facing path.
    if (pathname.includes("sendSmsFromLead")) requests.push(request);
  });
  return requests;
}

async function seedReplyThread(
  addressTag: string,
  consent: "in" | "out",
): Promise<SeededThread> {
  phoneCounter += 1;
  // Reply preparation deliberately requires an active `sendillo` sender
  // snapshot. The acceptance web server still uses the mock provider for
  // dispatch, so keep the normal mock catalog intact and add this explicit
  // policy fixture for the canonical business number.
  await seedSenderCatalog(admin, DEFAULT_ORG_ID, [E2E_MOCK_BUSINESS_NUMBER], {
    provider: "sendillo",
  });
  const thread = await seedAcceptanceThread(admin, {
    phone: `+1816555${String(7000 + phoneCounter).padStart(4, "0")}`,
    businessNumber: E2E_MOCK_BUSINESS_NUMBER,
    propertyState: process.env.INBOX_ACCEPTANCE_REPLY_STATE ?? "MO",
    addressTag,
    contactName: { first: "Inbox", last: addressTag.replace(/[^A-Za-z0-9]/g, "") },
    messages: [
      {
        direction: "inbound",
        body: "Could you send the details?",
        createdAtOffsetMin: -2,
      },
    ],
  });
  const { error } = await admin.from("consent_events").insert({
    contact_id: thread.contactId,
    channel: "sms",
    event_type: consent === "in" ? "opt_in_marketing_written" : "opt_out",
    source: "e2e-inbox-reviewed-replies",
  });
  expect(error).toBeNull();
  return thread;
}

async function openKnown(page: Page, thread: SeededThread, includeRestricted = false) {
  await page.goto("/inbox?view=all");
  if (includeRestricted) {
    const noiseToggle = page.getByRole("checkbox", { name: "Hide DNC and test conversations" });
    await expect(noiseToggle).toBeEnabled();
    await expect(noiseToggle).toBeChecked();
    // The controlled filter commits only after its workset request succeeds.
    await noiseToggle.click();
    await expect(noiseToggle).not.toBeChecked();
  }
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(list.getByText(thread.contactName)).toBeVisible();
  await page.getByRole("button", { name: `Open ${thread.contactName}` }).click();
  const detail = page.getByRole("complementary", { name: "Open conversation" });
  await expect(detail).toBeVisible();
  const composer = detail.getByRole("region", { name: "Reply to conversation" });
  await expect(composer).toBeVisible();
  return composer;
}

async function createTemplate(name: string, content: string): Promise<void> {
  const { data, error } = await admin
    .from("sms_templates")
    .insert({
      org_id: DEFAULT_ORG_ID,
      name,
      content,
      category: "General",
      system_managed: false,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  expect(data?.id).toBeTruthy();
  templateIds.push(data!.id);
}

async function acceptedStatus(page: Page, operationId: string): Promise<Record<string, unknown>> {
  let latest: Record<string, unknown> | null = null;
  await expect
    .poll(
      async () => {
        const response = await browserJson(
          page,
          `/api/inbox/replies/${encodeURIComponent(operationId)}`,
        );
        if (response.status !== 200 || response.data === null || typeof response.data !== "object") return false;
        latest = response.data as Record<string, unknown>;
        return latest.operationId === operationId && Array.isArray(latest.items) && Array.isArray(latest.receipts);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  if (!latest) throw new Error("Reply status did not become readable after acceptance.");
  return latest;
}

test.describe.serial("Inbox reviewed replies (runtime-unproven)", () => {
  test.skip(
    !shouldRun,
    "Runtime-unproven: set INBOX_ACCEPTANCE_RUN=1 through the dedicated acceptance config after coordinator runtime handoff.",
  );

  test.beforeAll(async () => {
    admin = adminClient();
    await ensureTestUser(admin);
  });

  test.beforeEach(async ({}, testInfo) => {
    purgeRowOutcomes(ROW_OWNERSHIP[testInfo.title] ?? []);
    templateIds = [];
    await resetAcceptanceFixture(admin);
    await ensureTestUser(admin);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (!shouldRun) return;
    for (const id of templateIds) {
      const { error } = await admin.from("sms_templates").delete().eq("id", id);
      expect(error).toBeNull();
    }
    const ids = ROW_OWNERSHIP[testInfo.title] ?? [];
    const alreadyRecorded = new Set(readMatrixResults().map((result) => result.id));
    for (const id of ids) {
      if (alreadyRecorded.has(id)) continue;
      if (testInfo.status === "skipped") {
        recordRowOutcome({ id, status: "skip", evidence: `test skipped (no explicit reason recorded for ${id})` });
      } else if (testInfo.status === "passed") {
        try {
          const evidence = await captureRowEvidence(page, id);
          recordRowOutcome({ id, status: "pass", evidence });
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

  test("R01 — write and edit a reviewed reply", async ({ page }) => {
    const thread = await seedReplyThread(`ACC-R01-${Date.now()}`, "in");
    const composer = await openKnown(page, thread);
    const body = `Original reviewed body ${Date.now()}`;
    const edited = `${body} — edited before acceptance`;

    await composer.getByRole("textbox", { name: "Reply message" }).fill(body);
    const prepareResponse = responseFor(page, "/api/inbox/replies/prepare", "POST");
    await composer.getByRole("button", { name: "Review reply", exact: true }).click();
    expect((await prepareResponse).status()).toBe(200);
    const review = page.getByRole("dialog", { name: "Review reply" });
    await expect(review).toContainText(body);

    await composer.getByRole("textbox", { name: "Reply message" }).fill(edited);
    await expect(review).toHaveCount(0);

    const { data: outbound, error } = await admin
      .from("messages")
      .select("id")
      .eq("conversation_id", thread.threadId)
      .eq("direction", "outbound");
    expect(error).toBeNull();
    expect(outbound ?? []).toHaveLength(0);
  });

  test("R02 — insert a template into a reviewed reply", async ({ page }) => {
    const thread = await seedReplyThread(`ACC-R02-${Date.now()}`, "in");
    const templateName = `E2E Inbox template ${Date.now()}`;
    const templateBody = "Hello {{first_name | there}}, here are the details.";
    await createTemplate(templateName, templateBody);

    const composer = await openKnown(page, thread);
    await composer.getByRole("button", { name: "Insert template" }).click();
    const search = page.getByPlaceholder("Search templates…");
    await expect(search).toBeVisible();
    await search.fill(templateName);
    await page.getByRole("button", { name: new RegExp(templateName) }).click();
    await expect(composer.getByRole("textbox", { name: "Reply message" })).toHaveValue(templateBody);

    const prepareResponse = responseFor(page, "/api/inbox/replies/prepare", "POST");
    await composer.getByRole("button", { name: "Review reply", exact: true }).click();
    expect((await prepareResponse).status()).toBe(200);
    await expect(page.getByRole("dialog", { name: "Review reply" })).toContainText("Hello Inbox");
  });

  test("R03 — Cmd/Ctrl+Enter opens review without acceptance", async ({ page }) => {
    const thread = await seedReplyThread(`ACC-R03-${Date.now()}`, "in");
    const requests = auditRequests(page);
    const composer = await openKnown(page, thread);
    const body = `Shortcut review body ${Date.now()}`;
    const textarea = composer.getByRole("textbox", { name: "Reply message" });
    await textarea.fill(body);
    const shortcut = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
    await textarea.press(shortcut);
    await expect(page.getByRole("dialog", { name: "Review reply" })).toBeVisible();

    expect(requests.filter((request) => new URL(request.url()).pathname === "/api/inbox/replies/prepare")).toHaveLength(1);
    expect(requests.filter((request) => new URL(request.url()).pathname === "/api/inbox/replies/accept")).toHaveLength(0);
    expect(requests.filter((request) => new URL(request.url()).pathname.includes("sendSmsFromLead"))).toHaveLength(0);
    const { data: outbound, error } = await admin
      .from("messages")
      .select("id")
      .eq("conversation_id", thread.threadId)
      .eq("direction", "outbound");
    expect(error).toBeNull();
    expect(outbound ?? []).toHaveLength(0);
  });

  test("R04 — explicit acceptance uses the conversation reply route", async ({ page }) => {
    const thread = await seedReplyThread(`ACC-R04-${Date.now()}`, "in");
    const requests = auditRequests(page);
    const composer = await openKnown(page, thread);
    const body = `Explicit accepted body ${Date.now()}`;
    await composer.getByRole("textbox", { name: "Reply message" }).fill(body);
    const prepareResponse = responseFor(page, "/api/inbox/replies/prepare", "POST");
    await composer.getByRole("button", { name: "Review reply", exact: true }).click();
    expect((await prepareResponse).status()).toBe(200);
    const review = page.getByRole("dialog", { name: "Review reply" });
    await expect(review).toContainText(body);

    const acceptResponse = responseFor(page, "/api/inbox/replies/accept", "POST");
    await review.getByRole("button", { name: "Accept reviewed reply", exact: true }).click();
    expect((await acceptResponse).status()).toBe(200);
    const accepted = (await (await acceptResponse).json()) as { operationId?: unknown };
    expect(accepted.operationId).toMatch(/^[0-9a-f-]{36}$/i);

    expect(requests.filter((request) => new URL(request.url()).pathname === "/api/inbox/replies/prepare")).toHaveLength(1);
    expect(requests.filter((request) => new URL(request.url()).pathname === "/api/inbox/replies/accept")).toHaveLength(1);
    expect(requests.filter((request) => new URL(request.url()).pathname.includes("sendSmsFromLead"))).toHaveLength(0);

    const status = await acceptedStatus(page, accepted.operationId as string);
    const items = status.items as Array<{ target?: { id?: string }; recipient?: { renderedBody?: string } }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.target?.id).toBe(thread.threadId);
    expect(items[0]?.recipient?.renderedBody).toBe(body);
    const receipts = status.receipts as Array<{ itemId?: string; state?: string }>;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.itemId).toBeTruthy();
    expect(receipts[0]?.state).toMatch(/^(pending|provider_accepted|delivered)$/);
  });

  test("R05 — restriction and route changes refuse the old review", async ({ page }) => {
    const restricted = await seedReplyThread(`ACC-R05-RESTRICTED-${Date.now()}`, "out");
    const eligibleA = await seedReplyThread(`ACC-R05-A-${Date.now()}`, "in");
    const eligibleB = await seedReplyThread(`ACC-R05-B-${Date.now()}`, "in");

    const requests = auditRequests(page);
    const restrictedComposer = await openKnown(page, restricted, true);
    await restrictedComposer.getByRole("textbox", { name: "Reply message" }).fill("This must be blocked");
    const restrictedPrepare = responseFor(page, "/api/inbox/replies/prepare", "POST");
    await restrictedComposer.getByRole("button", { name: "Review reply", exact: true }).click();
    expect((await restrictedPrepare).status()).toBe(200);
    const restrictedReview = page.getByRole("dialog", { name: "Review reply" });
    await expect(restrictedReview).toContainText(/Blocked: (sms_suppressed|contact_suppressed)/);
    await expect(restrictedReview.getByRole("button", { name: "Accept reviewed reply", exact: true })).toBeDisabled();

    const composerA = await openKnown(page, eligibleA);
    await composerA.getByRole("textbox", { name: "Reply message" }).fill("Review before route change");
    const routeChangePrepare = responseFor(page, "/api/inbox/replies/prepare", "POST");
    await composerA.getByRole("button", { name: "Review reply", exact: true }).click();
    expect((await routeChangePrepare).status()).toBe(200);
    await expect(page.getByRole("dialog", { name: "Review reply" })).toBeVisible();

    await page.getByRole("button", { name: `Open ${eligibleB.contactName}` }).click();
    await expect(page.getByRole("dialog", { name: "Review reply" })).toHaveCount(0);
    const composerB = page.getByRole("region", { name: "Reply to conversation" });
    await expect(composerB.getByRole("textbox", { name: "Reply message" })).toHaveValue("");
    expect(requests.filter((request) => new URL(request.url()).pathname === "/api/inbox/replies/accept")).toHaveLength(0);
    expect(requests.filter((request) => new URL(request.url()).pathname.includes("sendSmsFromLead"))).toHaveLength(0);

    const { data: outbound, error } = await admin
      .from("messages")
      .select("id")
      .eq("conversation_id", eligibleA.threadId)
      .eq("direction", "outbound");
    expect(error).toBeNull();
    expect(outbound ?? []).toHaveLength(0);
  });
});
