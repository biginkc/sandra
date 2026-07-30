import { test, expect } from "@playwright/test";

import { adminClient, resetTenantTables, seedProspects } from "./fixtures";

/**
 * SMS round-trip smoke. Simulates an inbound Dialpad delivery by
 * POSTing to /api/webhooks/dialpad/sms with the mock provider's
 * signature, then asserts:
 *   1. the inbound message renders in the lead-detail thread
 *   2. the property stays a prospect until a human promotes it
 *
 * Exercises the full path: external event → webhook handler → DB →
 * server-rendered lead detail. Integration tests cover the handler
 * alone; this one adds browser + auth + routing on top.
 */
test("inbound webhook lands in thread and leaves the prospect for manual review", async ({
  page,
  request,
  baseURL,
}) => {
  const admin = adminClient();
  await resetTenantTables(admin);

  const phone = "+18165559123";

  // Seed a homeowner contact with the inbound phone number.
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: "Inbound",
      last_name: "Smoke",
      phone_1: phone,
    })
    .select("id")
    .single();
  if (!contact) throw new Error("contact seed failed");

  // Seed a prospect property tied to that contact.
  const [prop] = await seedProspects(admin, 1, "SMS");
  await admin
    .from("properties")
    .update({ homeowner_contact_id: contact.id })
    .eq("id", prop.id);

  // Seed an outbound message so the webhook's "most recent outbound for
  // this contact" lookup resolves a propertyId for threading.
  await admin.from("messages").insert({
    channel: "sms",
    direction: "outbound",
    status: "sent",
    from_address: "+18163706846",
    to_address: phone,
    body: "Hey — is 789 Golden Path Ln still for sale?",
    contact_id: contact.id,
    property_id: prop.id,
  });

  // POST the inbound. The mock provider accepts `x-mock-signature: valid`.
  const inboundBody = `Reply smoke ${Date.now()}`;
  const res = await request.post(`${baseURL}/api/webhooks/dialpad/sms`, {
    headers: {
      "x-mock-signature": "valid",
      "content-type": "application/json",
    },
    data: {
      externalId: `e2e_sms_${Date.now()}`,
      from: phone,
      to: "+18163706846",
      body: inboundBody,
    },
  });
  expect(res.status()).toBe(200);

  // Inbound replies no longer promote prospects automatically.
  await expect(async () => {
    const { data } = await admin
      .from("properties")
      .select("status, qualified_at, qualified_by")
      .eq("id", prop.id)
      .single();
    expect(data?.status).toBe("prospect");
    expect(data?.qualified_at).toBeNull();
    expect(data?.qualified_by).toBeNull();
  }).toPass({ timeout: 5_000 });

  // Inbound message is threaded to the property and renders in the
  // lead-detail server-rendered thread.
  await page.goto(`/leads/${prop.id}`);
  await expect(page.locator(`text=${inboundBody}`)).toBeVisible();
});
