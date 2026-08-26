import { expect, test } from "@playwright/test";

import {
  adminClient,
  DEFAULT_ORG_ID,
  E2E_MOCK_BUSINESS_NUMBER,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";
import { checkQuietHours, STATE_TO_TZ } from "../src/lib/messaging/quiet-hours";
import { ensureConversationIdForThread } from "../src/lib/messages/threading";
import { formatPhoneE164 } from "../src/lib/phone-format";
import { MOCK_SENDER_SECONDARY } from "../tests/integration/delivery";

/**
 * Feature 8 Phase 1 — the cockpit message thread and the lead detail unified
 * activity timeline share message rows and InlineReply behavior. A reply
 * written from either surface must appear on the other after a refresh.
 */

let phoneCounter = 0;

function uniquePhone(): string {
  phoneCounter += 1;
  const tail = String(Date.now() + phoneCounter)
    .slice(-7)
    .padStart(7, "0");
  return `+1816${tail}`;
}

async function seedConsentedLead(
  admin: ReturnType<typeof adminClient>,
  opts: { phone: string; addressTag: string; state: string },
): Promise<{ contactId: string; propertyId: string; threadId: string }> {
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: "Parity",
      last_name: "Test",
      phone_1: opts.phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (!contact) throw new Error("contact seed failed");

  const [prop] = await seedProspects(admin, 1, opts.addressTag);
  await admin
    .from("properties")
    .update({
      homeowner_contact_id: contact.id,
      status: "new_lead",
      state: opts.state,
    })
    .eq("id", prop.id);

  await admin.from("consent_events").insert({
    contact_id: contact.id,
    channel: "sms",
    event_type: "opt_in_marketing_written",
    source: "e2e-cockpit-parity",
  });
  const conversationId = await ensureConversationIdForThread(
    admin,
    contact.id,
    prop.id,
  );

  // The inbound webhook threads regular replies to the contact's most recent
  // outbound property, matching the production conversation path.
  await admin.from("messages").insert({
    channel: "sms",
    direction: "outbound",
    status: "sent",
    conversation_id: conversationId,
    contact_id: contact.id,
    property_id: prop.id,
    from_address: E2E_MOCK_BUSINESS_NUMBER,
    to_address: opts.phone,
    body: "previous outbound",
  });

  await admin.from("messages").insert({
    channel: "sms",
    direction: "inbound",
    status: "received",
    conversation_id: conversationId,
    contact_id: contact.id,
    property_id: prop.id,
    from_address: opts.phone,
    to_address: E2E_MOCK_BUSINESS_NUMBER,
    body: "starting the thread",
  });

  return {
    contactId: contact.id,
    propertyId: prop.id,
    threadId: conversationId,
  };
}

async function seedLatestInboundRoute(
  admin: ReturnType<typeof adminClient>,
  seeded: { contactId: string; propertyId: string; threadId: string },
  customerPhone: string,
  businessPhone: string,
): Promise<void> {
  const { error: ageError } = await admin
    .from("messages")
    .update({ created_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("conversation_id", seeded.threadId);
  if (ageError) throw new Error(`message aging failed: ${ageError.message}`);

  const { error: messageError } = await admin.from("messages").insert({
    channel: "sms",
    direction: "inbound",
    status: "received",
    conversation_id: seeded.threadId,
    contact_id: seeded.contactId,
    property_id: seeded.propertyId,
    from_address: customerPhone,
    to_address: businessPhone,
    body: "newest paired route",
    created_at: new Date().toISOString(),
  });
  if (messageError) {
    throw new Error(`latest route seed failed: ${messageError.message}`);
  }
}

async function seedPhoneSuppression(
  admin: ReturnType<typeof adminClient>,
  phone: string,
  contactId: string,
): Promise<void> {
  const { error } = await admin.from("sms_phone_suppressions").insert({
    org_id: DEFAULT_ORG_ID,
    channel: "sms",
    phone_e164: phone,
    source: "e2e-lead-detail-slot-restriction",
    first_contact_id: contactId,
  });
  if (error) throw new Error(`phone suppression seed failed: ${error.message}`);
}

function callableStateForNow(): string | null {
  for (const state of Object.keys(STATE_TO_TZ).sort()) {
    if (checkQuietHours(state).ok) return state;
  }
  return null;
}

test("reply from cockpit shows up on the lead detail page (test 29)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const callableState = callableStateForNow();
  if (callableState === null) {
    test.skip(true, "outside legal send windows in every configured US state");
    return;
  }
  const { propertyId, threadId } = await seedConsentedLead(admin, {
    phone: uniquePhone(),
    addressTag: "PARITY-29",
    state: callableState,
  });

  await page.goto(`/messages?thread=${encodeURIComponent(threadId)}`);
  const reply = `parity from cockpit ${Date.now()}`;
  await page.getByPlaceholder(/Type.*reply/i).fill(reply);
  await page.getByTestId("inline-reply-send").click();

  // Wait for DB row.
  await expect(async () => {
    const { data } = await admin
      .from("messages")
      .select("status, external_id")
      .eq("property_id", propertyId)
      .eq("body", reply);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ status: "sent" });
    expect(data![0].external_id).toMatch(/^mock_/);
  }).toPass({ timeout: 10_000 });

  // Switch to lead detail.
  await page.goto(`/leads/${propertyId}`);
  const leadBubble = page
    .getByTestId("messages-thread-msg")
    .filter({ hasText: reply });
  await expect(leadBubble).toBeVisible();
  await expect(
    leadBubble.getByTestId("messages-thread-delivery-status"),
  ).toHaveText("Sent");
});

test("reply from lead detail shows up on the cockpit (test 30)", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const callableState = callableStateForNow();
  if (callableState === null) {
    test.skip(true, "outside legal send windows in every configured US state");
    return;
  }
  const { propertyId, threadId } = await seedConsentedLead(admin, {
    phone: uniquePhone(),
    addressTag: "PARITY-30",
    state: callableState,
  });

  await page.goto(`/leads/${propertyId}`);
  const reply = `parity from lead detail ${Date.now()}`;
  // Lead detail uses the same InlineReply component, same placeholder text.
  await page.getByPlaceholder(/Type.*reply/i).fill(reply);
  await page.getByTestId("inline-reply-send").click();

  await expect(async () => {
    const { data } = await admin
      .from("messages")
      .select("status, external_id")
      .eq("property_id", propertyId)
      .eq("body", reply);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ status: "sent" });
    expect(data![0].external_id).toMatch(/^mock_/);
  }).toPass({ timeout: 10_000 });

  await page.goto(`/messages?thread=${encodeURIComponent(threadId)}`);
  const cockpitBubble = page
    .getByTestId("messages-thread-msg")
    .filter({ hasText: reply });
  await expect(cockpitBubble).toBeVisible();
  await expect(
    cockpitBubble.getByTestId("messages-thread-delivery-status"),
  ).toHaveText("Sent");
});

test("lead detail replies on the newest paired customer and business route", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const callableState = callableStateForNow();
  if (callableState === null) {
    test.skip(true, "outside legal send windows in every configured US state");
    return;
  }

  const firstPhone = uniquePhone();
  const secondPhone = uniquePhone();
  const seeded = await seedConsentedLead(admin, {
    phone: firstPhone,
    addressTag: "PAIRED-ROUTE",
    state: callableState,
  });
  const { error: contactError } = await admin
    .from("contacts")
    .update({ phone_2: secondPhone, phone_2_type: "mobile" })
    .eq("id", seeded.contactId);
  if (contactError) {
    throw new Error(`second phone seed failed: ${contactError.message}`);
  }
  // The header's preferred phone is suppressed while the active thread phone
  // is clear. Inline reply must use the thread phone's independent decision.
  await seedPhoneSuppression(admin, firstPhone, seeded.contactId);
  await seedLatestInboundRoute(
    admin,
    seeded,
    secondPhone,
    MOCK_SENDER_SECONDARY,
  );

  // Newer rows that did not establish a successful route must not override
  // the property-linked received message above.
  const propertylessThreadId = await ensureConversationIdForThread(
    admin,
    seeded.contactId,
    null,
  );
  const nonAuthoritativeBase = Date.now() + 60_000;
  const { error: nonAuthoritativeError } = await admin.from("messages").insert([
    {
      channel: "sms",
      direction: "inbound",
      status: "received",
      conversation_id: propertylessThreadId,
      contact_id: seeded.contactId,
      property_id: null,
      from_address: firstPhone,
      to_address: E2E_MOCK_BUSINESS_NUMBER,
      body: "newer unrelated propertyless route",
      created_at: new Date(nonAuthoritativeBase).toISOString(),
    },
    {
      channel: "sms",
      direction: "outbound",
      status: "failed",
      conversation_id: seeded.threadId,
      contact_id: seeded.contactId,
      property_id: seeded.propertyId,
      from_address: E2E_MOCK_BUSINESS_NUMBER,
      to_address: firstPhone,
      body: "newer failed route",
      created_at: new Date(nonAuthoritativeBase + 1_000).toISOString(),
    },
    {
      channel: "sms",
      direction: "outbound",
      status: "queued",
      conversation_id: seeded.threadId,
      contact_id: seeded.contactId,
      property_id: seeded.propertyId,
      from_address: E2E_MOCK_BUSINESS_NUMBER,
      to_address: firstPhone,
      body: "newer queued route",
      created_at: new Date(nonAuthoritativeBase + 2_000).toISOString(),
    },
  ]);
  if (nonAuthoritativeError) {
    throw new Error(
      `non-authoritative route seed failed: ${nonAuthoritativeError.message}`,
    );
  }

  await page.goto(`/leads/${seeded.propertyId}`);
  await expect(
    page.getByTestId("sms-channel-restriction-header"),
  ).toBeVisible();
  const inlineReply = page.getByTestId("inline-reply");
  await expect(inlineReply).toContainText(formatPhoneE164(secondPhone)!);
  await expect(inlineReply).toContainText(
    formatPhoneE164(MOCK_SENDER_SECONDARY)!,
  );

  const reply = `paired route ${Date.now()}`;
  await inlineReply.getByLabel("Reply to this lead").fill(reply);
  await inlineReply.getByTestId("inline-reply-send").click();

  await expect(async () => {
    const { data } = await admin
      .from("messages")
      .select("from_address, to_address, status, external_id")
      .eq("property_id", seeded.propertyId)
      .eq("body", reply);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      from_address: MOCK_SENDER_SECONDARY,
      to_address: secondPhone,
      status: "sent",
    });
    expect(data![0].external_id).toMatch(/^mock_/);
  }).toPass({ timeout: 10_000 });
});

test("lead detail restricts the suppressed thread phone without hiding a clear header phone", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const preferredPhone = uniquePhone();
  const suppressedThreadPhone = uniquePhone();
  const seeded = await seedConsentedLead(admin, {
    phone: preferredPhone,
    addressTag: "SPLIT-SUPPRESSION",
    state: "MO",
  });
  const { error: contactError } = await admin
    .from("contacts")
    .update({ phone_2: suppressedThreadPhone, phone_2_type: "mobile" })
    .eq("id", seeded.contactId);
  if (contactError) {
    throw new Error(`second phone seed failed: ${contactError.message}`);
  }
  await seedPhoneSuppression(
    admin,
    suppressedThreadPhone,
    seeded.contactId,
  );
  await seedLatestInboundRoute(
    admin,
    seeded,
    suppressedThreadPhone,
    MOCK_SENDER_SECONDARY,
  );

  await page.goto(`/leads/${seeded.propertyId}`);
  await expect(page.getByRole("button", { name: "Send SMS" })).toBeVisible();
  await expect(
    page.getByTestId("sms-channel-restriction-inline"),
  ).toContainText("SMS is disabled");
  await expect(page.getByTestId("inline-reply")).toHaveCount(0);
});

test("lead detail blocks an existing thread whose customer number is unsaved", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const savedPhone = uniquePhone();
  const unsavedThreadPhone = uniquePhone();
  const seeded = await seedConsentedLead(admin, {
    phone: savedPhone,
    addressTag: "UNSAVED-ROUTE",
    state: "MO",
  });
  await seedPhoneSuppression(admin, savedPhone, seeded.contactId);
  await seedLatestInboundRoute(
    admin,
    seeded,
    unsavedThreadPhone,
    MOCK_SENDER_SECONDARY,
  );

  await page.goto(`/leads/${seeded.propertyId}`);
  await expect(
    page.getByTestId("sms-channel-restriction-header"),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This thread number is not saved on the homeowner contact — save it before replying.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("inline-reply")).toHaveCount(0);
});

test("lead detail blocks a landline thread even when another saved phone is mobile", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const mobilePhone = uniquePhone();
  const landlinePhone = uniquePhone();
  const seeded = await seedConsentedLead(admin, {
    phone: mobilePhone,
    addressTag: "LANDLINE-ROUTE",
    state: "MO",
  });
  const { error: contactError } = await admin
    .from("contacts")
    .update({ phone_2: landlinePhone, phone_2_type: "landline" })
    .eq("id", seeded.contactId);
  if (contactError) {
    throw new Error(`landline seed failed: ${contactError.message}`);
  }
  await seedPhoneSuppression(admin, mobilePhone, seeded.contactId);
  await seedLatestInboundRoute(
    admin,
    seeded,
    landlinePhone,
    MOCK_SENDER_SECONDARY,
  );

  await page.goto(`/leads/${seeded.propertyId}`);
  await expect(
    page.getByTestId("sms-channel-restriction-header"),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This thread number is saved as a landline — use a mobile number for SMS.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("inline-reply")).toHaveCount(0);
});

test("lead detail blocks a landline-only lead without an authoritative thread", async ({
  page,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);
  const landlinePhone = uniquePhone();
  const seeded = await seedConsentedLead(admin, {
    phone: landlinePhone,
    addressTag: "LANDLINE-NO-ROUTE",
    state: "MO",
  });
  const { error: contactError } = await admin
    .from("contacts")
    .update({ phone_1_type: "landline" })
    .eq("id", seeded.contactId);
  if (contactError) {
    throw new Error(`landline seed failed: ${contactError.message}`);
  }
  const { error: messageError } = await admin
    .from("messages")
    .delete()
    .eq("conversation_id", seeded.threadId);
  if (messageError) {
    throw new Error(`message cleanup failed: ${messageError.message}`);
  }

  await page.goto(`/leads/${seeded.propertyId}`);
  await expect(
    page.getByTestId("sms-channel-restriction-header"),
  ).toBeVisible();
  await expect(
    page.getByText(
      "SMS cannot be delivered to the selected landline. Call or mail instead.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("inline-reply")).toHaveCount(0);
});

test("Realtime cross-surface: both surfaces update from the other (test 31)", async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const phone = uniquePhone();
  const { contactId, propertyId, threadId } = await seedConsentedLead(admin, {
    phone,
    addressTag: "PARITY-31",
    state: "MO",
  });

  const leadContext = await browser.newContext({
    storageState: "e2e/.auth/user.json",
  });
  const leadPage = await leadContext.newPage();

  try {
    await Promise.all([
      page.goto(`/messages?thread=${encodeURIComponent(threadId)}`),
      leadPage.goto(`/leads/${propertyId}`),
    ]);
    await Promise.all([
      expect(page.getByTestId("messages-thread")).toContainText(
        "starting the thread",
      ),
      expect(leadPage.getByTestId("lead-activity-timeline")).toContainText(
        "starting the thread",
      ),
    ]);
    await Promise.all([
      page.waitForLoadState("networkidle"),
      leadPage.waitForLoadState("networkidle"),
    ]);
    await Promise.all([
      page.waitForTimeout(1000),
      leadPage.waitForTimeout(1000),
    ]);

    const inboundBody = `cross surface realtime ${Date.now()}`;
    const res = await request.post(`${baseURL}/api/webhooks/dialpad/sms`, {
      headers: {
        "x-mock-signature": "valid",
        "content-type": "application/json",
      },
      data: {
        externalId: `e2e_parity31_${Date.now()}`,
        from: phone,
        to: E2E_MOCK_BUSINESS_NUMBER,
        body: inboundBody,
      },
    });
    expect(res.status()).toBe(200);

    await expect(async () => {
      const { data } = await admin
        .from("messages")
        .select("id")
        .eq("body", inboundBody)
        .eq("contact_id", contactId)
        .eq("property_id", propertyId);
      expect(data).toHaveLength(1);
    }).toPass({ timeout: 10_000 });

    await Promise.all([
      expect(page.getByTestId("messages-thread")).toContainText(inboundBody, {
        timeout: 20_000,
      }),
      expect(leadPage.getByTestId("lead-activity-timeline")).toContainText(
        inboundBody,
        { timeout: 20_000 },
      ),
    ]);
  } finally {
    await leadContext.close();
  }
});
