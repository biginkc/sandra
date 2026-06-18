import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";
import { checkQuietHours, STATE_TO_TZ } from "../src/lib/messaging/quiet-hours";
import { ensureConversationIdForThread } from "../src/lib/messages/threading";

/**
 * Feature 8 Phase 1 — the cockpit and the lead detail page share the
 * same MessagesThread + InlineReply components. A reply written from
 * either surface must appear on the other after a refresh.
 */

let phoneCounter = 0;

function uniquePhone(): string {
  phoneCounter += 1;
  const tail = String(Date.now() + phoneCounter).slice(-7).padStart(7, "0");
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
    from_address: "+18162804181",
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
    to_address: "+18162804181",
    body: "starting the thread",
  });

  return {
    contactId: contact.id,
    propertyId: prop.id,
    threadId: conversationId,
  };
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
  await page.getByRole("button", { name: /Send reply/i }).click();

  // Wait for DB row.
  await expect(async () => {
    const { data } = await admin
      .from("messages")
      .select("status")
      .eq("property_id", propertyId)
      .eq("body", reply);
    expect(data).toHaveLength(1);
  }).toPass({ timeout: 10_000 });

  // Switch to lead detail.
  await page.goto(`/leads/${propertyId}`);
  await expect(page.getByText(reply)).toBeVisible();
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
  await page.getByRole("button", { name: /Send reply/i }).click();

  await expect(async () => {
    const { data } = await admin
      .from("messages")
      .select("status")
      .eq("property_id", propertyId)
      .eq("body", reply);
    expect(data).toHaveLength(1);
  }).toPass({ timeout: 10_000 });

  await page.goto(`/messages?thread=${encodeURIComponent(threadId)}`);
  await expect(page.getByTestId("inbox-detail-panel")).toContainText(reply);
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
    state: callableStateForNow() ?? "MO",
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
      expect(leadPage.getByTestId("messages-thread")).toContainText(
        "starting the thread",
      ),
    ]);
    await Promise.all([
      page.waitForLoadState("networkidle"),
      leadPage.waitForLoadState("networkidle"),
    ]);
    await Promise.all([page.waitForTimeout(1000), leadPage.waitForTimeout(1000)]);

    const inboundBody = `cross surface realtime ${Date.now()}`;
    const res = await request.post(`${baseURL}/api/webhooks/dialpad/sms`, {
      headers: {
        "x-mock-signature": "valid",
        "content-type": "application/json",
      },
      data: {
        externalId: `e2e_parity31_${Date.now()}`,
        from: phone,
        to: "+18162804181",
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
      expect(leadPage.getByTestId("messages-thread")).toContainText(inboundBody, {
        timeout: 20_000,
      }),
    ]);
  } finally {
    await leadContext.close();
  }
});
