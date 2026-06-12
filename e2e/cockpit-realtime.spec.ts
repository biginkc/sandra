import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";
import { ensureConversationIdForThread } from "../src/lib/messages/threading";

/**
 * Feature 8 Phase 1 — live updates from the inbound webhook to the
 * cockpit thread list and open thread panel via Supabase Realtime.
 */

async function seedThreaded(
  admin: ReturnType<typeof adminClient>,
  opts: { phone: string; addressTag: string },
): Promise<{ contactId: string; propertyId: string; threadId: string }> {
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: "RT",
      last_name: "Test",
      phone_1: opts.phone,
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
    })
    .eq("id", prop.id);
  const conversationId = await ensureConversationIdForThread(
    admin,
    contact.id,
    prop.id,
  );
  // Prior outbound so the inbound webhook can resolve a property by phone.
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
  return {
    contactId: contact.id,
    propertyId: prop.id,
    threadId: conversationId,
  };
}

test("inbound webhook adds a thread to the inbox via Realtime (test 26)", async ({
  page,
  request,
  baseURL,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const { threadId } = await seedThreaded(admin, {
    phone: "+18165557301",
    addressTag: "RT-26",
  });

  await page.goto("/messages");
  // Existing thread visible from prior outbound.
  await expect(
    page.getByTestId(`inbox-thread-${threadId}`),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);

  const inboundBody = `realtime inbound ${Date.now()}`;
  const res = await request.post(`${baseURL}/api/webhooks/dialpad/sms`, {
    headers: {
      "x-mock-signature": "valid",
      "content-type": "application/json",
    },
    data: {
      externalId: `e2e_rt26_${Date.now()}`,
      from: "+18165557301",
      to: "+18162804181",
      body: inboundBody,
    },
  });
  expect(res.status()).toBe(200);

  // Thread row should refresh via Realtime → show new last-message preview.
  await expect(
    page.getByTestId(`inbox-thread-${threadId}`),
  ).toContainText(inboundBody, { timeout: 20_000 });
});

test("inbound to a currently-open thread appears in the panel (test 27)", async ({
  page,
  request,
  baseURL,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const { threadId } = await seedThreaded(admin, {
    phone: "+18165557302",
    addressTag: "RT-27",
  });

  await page.goto(`/messages?thread=${encodeURIComponent(threadId)}`);
  await expect(page.getByTestId("inbox-detail-panel")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);

  const inboundBody = `panel realtime inbound ${Date.now()}`;
  await request.post(`${baseURL}/api/webhooks/dialpad/sms`, {
    headers: {
      "x-mock-signature": "valid",
      "content-type": "application/json",
    },
    data: {
      externalId: `e2e_rt27_${Date.now()}`,
      from: "+18165557302",
      to: "+18162804181",
      body: inboundBody,
    },
  });

  await expect(page.getByTestId("inbox-detail-panel")).toContainText(
    inboundBody,
    { timeout: 20_000 },
  );
});

test("two browsers, A opens thread B sends inbound, both see the bubble (test 28)", async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const phone = "+18165557303";
  const { threadId } = await seedThreaded(admin, {
    phone,
    addressTag: "RT-28",
  });

  const secondContext = await browser.newContext({
    storageState: "e2e/.auth/user.json",
  });
  const secondPage = await secondContext.newPage();

  try {
    await Promise.all([
      page.goto(`/messages?thread=${encodeURIComponent(threadId)}`),
      secondPage.goto(`/messages?thread=${encodeURIComponent(threadId)}`),
    ]);
    await Promise.all([
      expect(page.getByTestId("inbox-detail-panel")).toBeVisible(),
      expect(secondPage.getByTestId("inbox-detail-panel")).toBeVisible(),
    ]);
    await Promise.all([
      expect(page.getByTestId("messages-thread")).toContainText(
        "previous outbound",
      ),
      expect(secondPage.getByTestId("messages-thread")).toContainText(
        "previous outbound",
      ),
    ]);
    await Promise.all([
      page.waitForLoadState("networkidle"),
      secondPage.waitForLoadState("networkidle"),
    ]);
    await Promise.all([
      page.waitForTimeout(1000),
      secondPage.waitForTimeout(1000),
    ]);

    const inboundBody = `two browser realtime inbound ${Date.now()}`;
    const res = await request.post(`${baseURL}/api/webhooks/dialpad/sms`, {
      headers: {
        "x-mock-signature": "valid",
        "content-type": "application/json",
      },
      data: {
        externalId: `e2e_rt28_${Date.now()}`,
        from: phone,
        to: "+18162804181",
        body: inboundBody,
      },
    });
    expect(res.status()).toBe(200);

    await Promise.all([
      expect(page.getByTestId("messages-thread")).toContainText(inboundBody, {
        timeout: 20_000,
      }),
      expect(secondPage.getByTestId("messages-thread")).toContainText(
        inboundBody,
        { timeout: 20_000 },
      ),
    ]);
  } finally {
    await secondContext.close();
  }
});
