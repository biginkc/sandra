import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";

/**
 * Feature 8 Phase 1 — live updates from the inbound webhook to the
 * cockpit thread list and open thread panel via Supabase Realtime.
 */

async function seedThreaded(
  admin: ReturnType<typeof adminClient>,
  opts: { phone: string; addressTag: string },
): Promise<{ contactId: string; propertyId: string }> {
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
  // Prior outbound so the inbound webhook can resolve a property by phone.
  await admin.from("messages").insert({
    channel: "sms",
    direction: "outbound",
    status: "sent",
    contact_id: contact.id,
    property_id: prop.id,
    from_address: "+18162804181",
    to_address: opts.phone,
    body: "previous outbound",
  });
  return { contactId: contact.id, propertyId: prop.id };
}

test("inbound webhook adds a thread to the inbox via Realtime (test 26)", async ({
  page,
  request,
  baseURL,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const { contactId } = await seedThreaded(admin, {
    phone: "+18165557301",
    addressTag: "RT-26",
  });

  await page.goto("/messages");
  // Existing thread visible from prior outbound.
  await expect(
    page.getByTestId(`inbox-thread-${contactId}`),
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
    page.getByTestId(`inbox-thread-${contactId}`),
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

  const { contactId } = await seedThreaded(admin, {
    phone: "+18165557302",
    addressTag: "RT-27",
  });

  await page.goto(`/messages?thread=${contactId}`);
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

test.skip("two browsers, A opens thread B sends inbound, both see the bubble (test 28)", async () => {
  // TODO: requires `browser.newContext()` with two storageStates and
  // careful Realtime handshake ordering. Mirror notifications.spec.ts
  // pattern when the cross-browser harness is settled.
});
