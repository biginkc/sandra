import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import {
  adminClient,
  DEFAULT_ORG_ID,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "../fixtures";
import { seedAcceptanceThread, type SeededThread } from "./seed";

/**
 * Individual Inbox acceptance coverage for the preserved known/unknown
 * workflows. This file deliberately uses the authenticated browser and the
 * service client only for fixture setup and persisted-result assertions. It
 * never mocks an Inbox route, sends an SMS, or places a call.
 *
 * RUNTIME-UNPROVEN: the suite is opt-in until the coordinator hands off the
 * installed Inbox RPC schema and an exclusive acceptance runtime:
 *
 *   INBOX_INDIVIDUAL_WORKFLOWS_RUN=1 npx playwright test \
 *     --config=playwright.inbox-acceptance.config.ts individual-workflows.spec.ts
 *
 * U07/U08 intentionally assert the existing Messages resolution affordances
 * by their stable test IDs. They are authored as required coverage even
 * though the current Inbox detail integration has not mounted that dialog.
 * A runtime failure there is an honest missing-affordance result, not a
 * substitute pass through U03/U04.
 */

const shouldRun = process.env.INBOX_INDIVIDUAL_WORKFLOWS_RUN === "1";

type UnknownSeed = { fromAddress: string; messageIds: string[] };

let admin: ReturnType<typeof adminClient>;

test.describe.serial("Inbox individual workflows (runtime-unproven)", () => {
  test.skip(
    !shouldRun,
    "Runtime-unproven: set INBOX_INDIVIDUAL_WORKFLOWS_RUN=1 after coordinator runtime handoff.",
  );

  test.beforeAll(async () => {
    admin = adminClient();
    await resetTenantTables(admin);
    await ensureTestUser(admin);
  });

  test.beforeEach(async () => {
    // Keep each domain assertion isolated. This suite is serial because the
    // acceptance fixture is shared, but each row still starts from a clean
    // persisted state and a fresh mock delivery catalog.
    await resetTenantTables(admin);
    await ensureTestUser(admin);
  });

  test("F11 — detail renders authoritative Sandra AI status", async ({ page }) => {
    const thread = await seedAcceptanceThread(admin, {
      phone: "+18165559111",
      addressTag: "ACC-F11-AI-STATUS",
      contactName: { first: "AI", last: "StatusF11" },
      messages: [{ direction: "inbound", body: "AI status probe", createdAtOffsetMin: -2 }],
    });
    const { error } = await admin
      .from("message_threads")
      .update({
        ai_responder_status: "escalated",
        ai_responder_reason: "model:needs_human",
        ai_responder_status_at: new Date().toISOString(),
        ai_last_delivery_status: "failed",
        ai_last_delivery_error: "mock delivery failure",
      })
      .eq("conversation_id", thread.threadId);
    expect(error).toBeNull();

    await openKnown(page, thread);
    const status = page.getByRole("region", { name: "Sandra AI status" });
    await expect(status).toContainText("Status: escalated");
    await expect(status).toContainText("model:needs_human");
    await expect(status).toContainText("Last delivery: failed");
    await expect(status).toContainText("mock delivery failure");
  });

  test("F12 — detail exposes record and copy-link controls", async ({ page }) => {
    const thread = await seedAcceptanceThread(admin, {
      phone: "+18165559112",
      addressTag: "ACC-F12-LINKS",
      contactName: { first: "Links", last: "F12" },
      messages: [{ direction: "inbound", body: "link probe", createdAtOffsetMin: -2 }],
    });

    await openKnown(page, thread);
    const detail = page.getByRole("complementary", { name: "Open conversation" });
    await expect(detail.getByRole("link", { name: "Open in Messages" })).toHaveAttribute(
      "href",
      `/messages?thread=${encodeURIComponent(thread.threadId)}`,
    );
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: "http://localhost:3456",
    });
    await detail.getByRole("button", { name: "Copy conversation link" }).click();
    await expect(detail.getByRole("status")).toHaveText("Conversation link copied");
  });

  test("F13 — detail exposes an eligible tel link without placing a call", async ({ page }) => {
    const phone = "+18165559113";
    const thread = await seedAcceptanceThread(admin, {
      phone,
      addressTag: "ACC-F13-CALL",
      contactName: { first: "Call", last: "F13" },
      messages: [{ direction: "inbound", body: "call probe", createdAtOffsetMin: -2 }],
    });

    await openKnown(page, thread);
    await expect(page.getByRole("link", { name: "Call" })).toHaveAttribute("href", `tel:${phone}`);
  });

  test("F14 — detail preserves the existing New Message destination", async ({ page }) => {
    const thread = await seedAcceptanceThread(admin, {
      phone: "+18165559114",
      addressTag: "ACC-F14-NEW-MESSAGE",
      contactName: { first: "Message", last: "F14" },
      messages: [{ direction: "inbound", body: "new message probe", createdAtOffsetMin: -2 }],
    });

    await openKnown(page, thread);
    await expect(page.getByRole("link", { name: "New message" })).toHaveAttribute(
      "href",
      "/leads?compose=1",
    );
  });

  test("A04 — Follow up applies nurture through the reviewed bulk lane", async ({ page }) => {
    const thread = await seedAcceptanceThread(admin, {
      phone: "+18165559115",
      addressTag: "ACC-A04-FOLLOW-UP",
      contactName: { first: "Follow", last: "UpA04" },
      messages: [{ direction: "inbound", body: "follow-up probe", createdAtOffsetMin: -2 }],
    });

    await applyBulkAction(page, thread.contactName, "Follow up");
    await expect.poll(async () => {
      const { data } = await admin.from("properties").select("outreach_dispo").eq("id", thread.propertyId).single();
      return data?.outreach_dispo ?? null;
    }).toBe("nurture");
  });

  test("A08 — Move to Lead persists the property transition", async ({ page }) => {
    const thread = await seedAcceptanceThread(admin, {
      phone: "+18165559116",
      addressTag: "ACC-A08-PROMOTE",
      contactName: { first: "Promote", last: "A08" },
      propertyStatus: "prospect",
      messages: [{ direction: "inbound", body: "promotion probe", createdAtOffsetMin: -2 }],
    });

    await openKnown(page, thread);
    await page.getByRole("button", { name: "Move to Lead" }).click();
    await expect.poll(async () => {
      const { data } = await admin.from("properties").select("status").eq("id", thread.propertyId).single();
      return data?.status ?? null;
    }).toBe("new_lead");
  });

  test("A09 — Book appointment persists an open appointment task", async ({ page }) => {
    const thread = await seedAcceptanceThread(admin, {
      phone: "+18165559117",
      addressTag: "ACC-A09-APPT",
      contactName: { first: "Appointment", last: "A09" },
      messages: [{ direction: "inbound", body: "appointment probe", createdAtOffsetMin: -2 }],
    });

    await openKnown(page, thread);
    await page.getByRole("button", { name: "Book appointment" }).click();
    await expect(page.getByTestId("book-appointment-popover")).toBeVisible();
    await chooseFutureAppointmentDate(page);
    await page.getByTestId("book-appointment-time").click();
    await page.getByRole("option", { name: "10:00 AM", exact: true }).click();
    await expect(page.getByTestId("book-appointment-timezone-label")).toBeVisible();
    await expect(page.getByTestId("book-appointment-submit")).toBeEnabled();
    await page.getByTestId("book-appointment-submit").click();
    await expect(page.getByTestId("book-appointment-popover")).toHaveCount(0);

    await expect.poll(async () => {
      const { data } = await admin
        .from("tasks")
        .select("id, status, related_property_id, type")
        .eq("related_property_id", thread.propertyId)
        .eq("type", "appointment")
        .eq("status", "open")
        .maybeSingle();
      return data?.id ?? null;
    }).not.toBeNull();
  });

  test("A12 — operator can confirm Sandra's pending disposition", async ({ page }) => {
    const thread = await seedReviewFixture("+18165559118", "ACC-A12-CONFIRM", "Confirm", "A12");
    const reviewId = await addPendingReview(thread, "not_interested");

    await openKnown(page, thread);
    await page.getByRole("button", { name: "Confirm Sandra disposition" }).click();
    await expect.poll(async () => {
      const { data } = await admin.from("ai_disposition_reviews").select("status, reviewed_by").eq("id", reviewId).single();
      return data ? { status: data.status, reviewed_by: data.reviewed_by } : null;
    }).toMatchObject({ status: "confirmed" });
  });

  test("A13 — correcting Sandra's disposition supersedes the review", async ({ page }) => {
    const thread = await seedReviewFixture("+18165559119", "ACC-A13-CORRECT", "Correct", "A13");
    const reviewId = await addPendingReview(thread, "not_interested");

    await openKnown(page, thread);
    await page.getByLabel("Correct Sandra disposition").selectOption("nurture");
    await page.getByRole("button", { name: "Save correction" }).click();
    await expect.poll(async () => {
      const [{ data: review }, { data: property }] = await Promise.all([
        admin.from("ai_disposition_reviews").select("status").eq("id", reviewId).single(),
        admin.from("properties").select("outreach_dispo").eq("id", thread.propertyId).single(),
      ]);
      return { review: review?.status ?? null, disposition: property?.outreach_dispo ?? null };
    }).toEqual({ review: "superseded", disposition: "nurture" });
  });

  test("U01 — unknown detail shows bounded sender history", async ({ page }) => {
    const unknown = await seedUnknownSender("+18165559201", ["unknown first", "unknown latest"]);
    await openUnknown(page, unknown.fromAddress);
    const history = page.getByRole("region", { name: "Unknown sender history" });
    await expect(history).toContainText("unknown first");
    await expect(history).toContainText("unknown latest");
    await expect(page.getByRole("region", { name: "Unknown sender actions" })).toBeVisible();
  });

  test("U02 — unknown sender merges into an existing contact", async ({ page }) => {
    const existing = await seedAcceptanceThread(admin, {
      phone: "+18165559202",
      addressTag: "ACC-U02-EXISTING",
      contactName: { first: "Existing", last: "ContactU02" },
      messages: [{ direction: "inbound", body: "existing contact context", createdAtOffsetMin: -3 }],
    });
    const unknown = await seedUnknownSender("+18165559203", ["merge contact"]);

    await openUnknown(page, unknown.fromAddress);
    await page.getByRole("button", { name: "Merge with existing contact" }).click();
    await page.getByTestId("match-search-input").fill(existing.contactName);
    await expect(page.getByTestId(`match-result-${existing.contactId}`)).toBeVisible();
    await page.getByTestId(`match-result-${existing.contactId}`).click();

    await expect.poll(async () => {
      const { data } = await admin.from("messages").select("contact_id").in("id", unknown.messageIds).single();
      return data?.contact_id ?? null;
    }).toBe(existing.contactId);
    await expect.poll(async () => {
      const { data } = await admin.from("contacts").select("phone_2, phone_3").eq("id", existing.contactId).single();
      return [data?.phone_2, data?.phone_3];
    }).toContain(unknown.fromAddress);
  });

  test("U03 — unknown sender merges into an existing property", async ({ page }) => {
    const unknown = await seedUnknownSender("+18165559204", ["merge property"]);
    const [property] = await seedProspects(admin, 1, "ACC-U03-PROPERTY");

    await openUnknown(page, unknown.fromAddress);
    await page.getByRole("button", { name: "Merge with existing property" }).click();
    await page.getByTestId("merge-property-search-input").fill(property.address.slice(0, 12));
    await expect(page.getByTestId(`merge-property-result-${property.id}`)).toBeVisible();
    await page.getByTestId(`merge-property-result-${property.id}`).click();
    await page.getByTestId("merge-property-role-homeowner").click();
    await page.getByTestId("merge-property-first").fill("Merged");
    await page.getByTestId("merge-property-last").fill("U03");
    await page.getByTestId("merge-property-submit").click();

    await expect.poll(async () => {
      const { data } = await admin.from("properties").select("homeowner_contact_id").eq("id", property.id).single();
      return data?.homeowner_contact_id ?? null;
    }).not.toBeNull();
    await expect.poll(async () => {
      const { data } = await admin.from("messages").select("property_id").in("id", unknown.messageIds).single();
      return data?.property_id ?? null;
    }).toBe(property.id);
  });

  test("U04 — unknown sender creates a new lead", async ({ page }) => {
    const unknown = await seedUnknownSender("+18165559205", ["create lead"]);
    await openUnknown(page, unknown.fromAddress);
    await page.getByRole("button", { name: "Create new lead" }).click();
    await page.getByTestId("role-homeowner").click();
    await page.getByTestId("create-first").fill("Created");
    await page.getByTestId("create-last").fill("U04");
    await page.getByTestId("create-address").fill("404 Inbox U04 Lane");
    await page.getByTestId("create-city").fill("Kansas City");
    await page.getByTestId("create-state").fill("MO");
    await page.getByTestId("create-submit").click();
    await page.waitForURL(/\/leads\/[a-f0-9-]+$/);

    const { data: contact } = await admin.from("contacts").select("id").eq("phone_1", unknown.fromAddress).single();
    expect(contact).not.toBeNull();
    await expect.poll(async () => {
      const { data } = await admin.from("properties").select("homeowner_contact_id").eq("homeowner_contact_id", contact!.id).maybeSingle();
      return data?.homeowner_contact_id ?? null;
    }).toBe(contact!.id);
    await expect.poll(async () => {
      const { data } = await admin.from("messages").select("contact_id, property_id").in("id", unknown.messageIds).single();
      return data;
    }).toMatchObject({ contact_id: contact!.id });
  });

  test("U07 — known contact resolves to an existing property", async ({ page }) => {
    const fixture = await seedPropertylessKnownThread("+18165559207", "ACC-U07-RESOLVE", "Resolve", "U07");
    const [property] = await seedProspects(admin, 1, "ACC-U07-CANDIDATE");
    await admin.from("properties").update({ homeowner_contact_id: fixture.contactId, status: "prospect" }).eq("id", property.id);

    await openKnownPropertyless(page, fixture.contactName);
    await expect(page.getByTestId("resolve-to-property-open")).toBeVisible();
    await page.getByTestId("resolve-to-property-open").click();
    await expect(page.getByTestId(`resolve-property-result-${property.id}`)).toBeVisible();
    await page.getByTestId(`resolve-property-result-${property.id}`).click();
    await page.getByTestId("resolve-property-submit").click();

    await expect.poll(async () => {
      const { data } = await admin.from("messages").select("property_id, conversation_id").eq("id", fixture.messageId).single();
      return data;
    }).toMatchObject({ property_id: property.id });
  });

  test("U08 — known contact creates a property and resolves", async ({ page }) => {
    const fixture = await seedPropertylessKnownThread("+18165559208", "ACC-U08-RESOLVE", "Create", "U08");

    await openKnownPropertyless(page, fixture.contactName);
    await expect(page.getByTestId("resolve-to-property-open")).toBeVisible();
    await page.getByTestId("resolve-to-property-open").click();
    await page.getByTestId("resolve-mode-create").click();
    await page.getByTestId("resolve-role-homeowner").click();
    await page.getByTestId("resolve-create-address").fill("808 Inbox U08 Lane");
    await page.getByTestId("resolve-create-city").fill("Kansas City");
    await page.getByTestId("resolve-create-state").fill("MO");
    await page.getByTestId("resolve-create-submit").click();

    await expect.poll(async () => {
      const { data } = await admin.from("properties").select("id, homeowner_contact_id").eq("homeowner_contact_id", fixture.contactId).maybeSingle();
      return data;
    }).toMatchObject({ homeowner_contact_id: fixture.contactId });
    await expect.poll(async () => {
      const { data } = await admin.from("messages").select("property_id").eq("id", fixture.messageId).single();
      return data?.property_id ?? null;
    }).not.toBeNull();
  });
});

async function openKnown(page: Page, thread: SeededThread): Promise<void> {
  await page.goto("/inbox?view=all");
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(list.getByText(thread.contactName)).toBeVisible();
  await page.getByRole("button", { name: `Open ${thread.contactName}` }).click();
  await expect(page.getByRole("complementary", { name: "Open conversation" })).toBeVisible();
}

async function openKnownPropertyless(page: Page, contactName: string): Promise<void> {
  await page.goto("/inbox?view=all");
  const row = page.getByRole("listitem").filter({ hasText: contactName }).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /^Open / }).click();
  await expect(page.getByRole("complementary", { name: "Open conversation" })).toBeVisible();
}

async function openUnknown(page: Page, fromAddress: string): Promise<void> {
  await page.goto("/inbox?view=unknown");
  const row = page.getByRole("listitem").filter({ hasText: fromAddress }).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /^Open / }).click();
  await expect(page.getByRole("complementary", { name: "Open conversation" })).toBeVisible();
}

async function applyBulkAction(page: Page, contactName: string, action: string): Promise<void> {
  await page.goto("/inbox?view=all");
  const list = page.getByRole("list", { name: "Inbox conversations" });
  await expect(list.getByText(contactName)).toBeVisible();
  await page.getByRole("checkbox", { name: `Select ${contactName}` }).click();
  await page.getByRole("button", { name: action, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review bulk action" });
  await expect(dialog).toBeVisible();
  const apply = dialog.getByRole("button", { name: /^Apply to \d+ conversations$/ });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByRole("region", { name: "Bulk action progress" }).getByText(/Action (accepted|succeeded|finished)/i)).toBeVisible({ timeout: 15_000 });
}

async function chooseFutureAppointmentDate(page: Page): Promise<void> {
  const calendar = page.getByTestId("book-appointment-calendar");
  const target = new Date();
  target.setDate(target.getDate() + 2);
  const monthDay = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" }).format(target);
  let day = calendar.getByRole("button", { name: new RegExp(monthDay) });
  for (let attempt = 0; attempt < 3 && (await day.count()) === 0; attempt += 1) {
    await calendar.getByRole("button", { name: /next month/i }).click();
    day = calendar.getByRole("button", { name: new RegExp(monthDay) });
  }
  await expect(day).toBeVisible();
  await day.click();
}

async function seedReviewFixture(phone: string, addressTag: string, first: string, last: string): Promise<SeededThread> {
  const thread = await seedAcceptanceThread(admin, {
    phone,
    addressTag,
    contactName: { first, last },
    messages: [{ direction: "inbound", body: `${addressTag} review source`, createdAtOffsetMin: -2 }],
  });
  const { error } = await admin.from("properties").update({ outreach_dispo: "not_interested" }).eq("id", thread.propertyId);
  expect(error).toBeNull();
  return thread;
}

async function addPendingReview(thread: SeededThread, disposition: "not_interested" | "wrong_number"): Promise<string> {
  const { data: inbound, error: inboundError } = await admin.from("messages").select("id").eq("conversation_id", thread.threadId).eq("direction", "inbound").single();
  expect(inboundError).toBeNull();
  expect(inbound).not.toBeNull();
  const { data: review, error } = await admin.from("ai_disposition_reviews").insert({
    org_id: DEFAULT_ORG_ID,
    property_id: thread.propertyId,
    conversation_id: thread.threadId,
    source_inbound_message_id: inbound!.id,
    disposition,
    ai_reason: "fixture review reason",
    status: "pending",
  }).select("id").single();
  expect(error).toBeNull();
  expect(review).not.toBeNull();
  return review!.id;
}

async function seedUnknownSender(fromAddress: string, bodies: readonly string[]): Promise<UnknownSeed> {
  const messageIds: string[] = [];
  for (const [index, body] of bodies.entries()) {
    const { data, error } = await admin.from("messages").insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
      contact_id: null,
      property_id: null,
      from_address: fromAddress,
      to_address: "+18162804181",
      body,
      created_at: new Date(Date.now() + index * 1000).toISOString(),
    }).select("id").single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    messageIds.push(data!.id);
  }
  return { fromAddress, messageIds };
}

async function seedPropertylessKnownThread(phone: string, addressTag: string, first: string, last: string): Promise<{ contactId: string; contactName: string; messageId: string; conversationId: string }> {
  const { data: contact, error: contactError } = await admin.from("contacts").insert({
    first_name: first,
    last_name: last,
    phone_1: phone,
    phone_1_type: "mobile",
  }).select("id").single();
  expect(contactError).toBeNull();
  expect(contact).not.toBeNull();
  const [property] = await seedProspects(admin, 1, addressTag);
  const { error: propertyError } = await admin.from("properties").update({ homeowner_contact_id: contact!.id, status: "prospect" }).eq("id", property.id);
  expect(propertyError).toBeNull();
  const conversationId = randomUUID();
  const { data: message, error } = await admin.from("messages").insert({
    channel: "sms",
    direction: "inbound",
    status: "received",
    contact_id: contact!.id,
    property_id: null,
    conversation_id: conversationId,
    from_address: phone,
    to_address: "+18162804181",
    body: `${addressTag} propertyless source`,
  }).select("id").single();
  expect(error).toBeNull();
  expect(message).not.toBeNull();
  return { contactId: contact!.id, contactName: `${first} ${last}`, messageId: message!.id, conversationId };
}
