import { expect, test } from "@playwright/test";

import {
  adminClient,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";

/**
 * Feature 8 Phase 1 — the cockpit and the lead detail page share the
 * same MessagesThread + InlineReply components. A reply written from
 * either surface must appear on the other after a refresh.
 */

async function seedConsentedLead(
  admin: ReturnType<typeof adminClient>,
  opts: { phone: string; addressTag: string },
): Promise<{ contactId: string; propertyId: string }> {
  const { data: contact } = await admin
    .from("contacts")
    .insert({
      first_name: "Parity",
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

  await admin.from("consent_events").insert({
    contact_id: contact.id,
    channel: "sms",
    event_type: "opt_in_marketing_written",
    source: "e2e-cockpit-parity",
  });

  await admin.from("messages").insert({
    channel: "sms",
    direction: "inbound",
    status: "received",
    contact_id: contact.id,
    property_id: prop.id,
    from_address: opts.phone,
    to_address: "+18162804181",
    body: "starting the thread",
  });

  return { contactId: contact.id, propertyId: prop.id };
}

function inBusinessHours(): boolean {
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
    10,
  );
  return hour >= 8 && hour < 21;
}

test("reply from cockpit shows up on the lead detail page (test 29)", async ({
  page,
}) => {
  if (!inBusinessHours()) test.skip(true, "outside business hours");
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const { contactId, propertyId } = await seedConsentedLead(admin, {
    phone: "+18165557401",
    addressTag: "PARITY-29",
  });

  await page.goto(`/messages?thread=${contactId}`);
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
  if (!inBusinessHours()) test.skip(true, "outside business hours");
  const admin = adminClient();
  await resetTenantTables(admin);
  await ensureTestUser(admin);

  const { contactId, propertyId } = await seedConsentedLead(admin, {
    phone: "+18165557402",
    addressTag: "PARITY-30",
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

  await page.goto(`/messages?thread=${contactId}`);
  await expect(page.getByTestId("inbox-detail-panel")).toContainText(reply);
});

test.skip("Realtime cross-surface: both surfaces update from the other (test 31)", async () => {
  // TODO: needs two browser contexts. Same blocker as cockpit-realtime test 28.
});
