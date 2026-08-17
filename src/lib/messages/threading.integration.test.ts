import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

import { resolveInboundThread } from "./threading";

const supabase = createTestClient();

async function getOrgId(): Promise<string> {
  return getCanonicalTestOrgId(supabase);
}

async function seedContact(phone: string): Promise<string> {
  const orgId = await getOrgId();
  const { data, error } = await supabase
    .from("contacts")
    .insert({
      org_id: orgId,
      contact_type: "person",
      first_name: "Threading",
      last_name: "Contact",
      phone_1: phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (error || !data?.id) {
    throw new Error(`contact seed failed: ${error?.message}`);
  }
  return data.id;
}

async function seedProperty(contactId: string, address: string): Promise<string> {
  const orgId = await getOrgId();
  const { data, error } = await supabase
    .from("properties")
    .insert({
      org_id: orgId,
      address,
      state: "MO",
      status: "new_lead",
      homeowner_contact_id: contactId,
    })
    .select("id")
    .single();
  if (error || !data?.id) {
    throw new Error(`property seed failed: ${error?.message}`);
  }
  return data.id;
}

async function seedOutbound(args: {
  contactId: string;
  propertyId: string;
  fromAddress: string;
  toAddress: string;
  body?: string;
  createdAt?: string;
}): Promise<void> {
  const orgId = await getOrgId();
  const { error } = await supabase.from("messages").insert({
    org_id: orgId,
    channel: "sms",
    direction: "outbound",
    status: "sent",
    provider: "sendillo",
    from_address: args.fromAddress,
    to_address: args.toAddress,
    body: args.body ?? `seed ${crypto.randomUUID()}`,
    contact_id: args.contactId,
    property_id: args.propertyId,
    created_at: args.createdAt,
  });
  if (error) throw new Error(`message seed failed: ${error.message}`);
}

async function seedOutboundBatch(
  rows: Array<{
    contactId: string;
    propertyId: string;
    fromAddress: string;
    toAddress: string;
    body: string;
    createdAt: string;
  }>,
): Promise<void> {
  const orgId = await getOrgId();
  const { error } = await supabase.from("messages").insert(
    rows.map((row) => ({
      org_id: orgId,
      channel: "sms",
      direction: "outbound",
      status: "sent",
      provider: "sendillo",
      from_address: row.fromAddress,
      to_address: row.toAddress,
      body: row.body,
      contact_id: row.contactId,
      property_id: row.propertyId,
      created_at: row.createdAt,
    })),
  );
  if (error) throw new Error(`message batch seed failed: ${error.message}`);
}

describe("resolveInboundThread sender-number routing", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("routes the same contact to the property last messaged from the inbound to-number", async () => {
    const phone = "+18165553001";
    const senderA = "+18164870001";
    const senderB = "+18164870002";
    const contactId = await seedContact(phone);
    const propertyA = await seedProperty(contactId, "1 Sender A Ln");
    const propertyB = await seedProperty(contactId, "2 Sender B Ln");

    await seedOutbound({
      contactId,
      propertyId: propertyA,
      fromAddress: senderA,
      toAddress: phone,
      body: "sender a outbound",
    });
    await seedOutbound({
      contactId,
      propertyId: propertyB,
      fromAddress: senderB,
      toAddress: phone,
      body: "sender b outbound",
    });

    const replyToA = await resolveInboundThread(supabase, phone, senderA);
    const replyToB = await resolveInboundThread(supabase, phone, senderB);

    expect(replyToA).toMatchObject({
      contactId,
      propertyId: propertyA,
      resolution: "matched_recipient_number",
    });
    expect(replyToA.conversationId).toBeTruthy();
    expect(replyToB).toMatchObject({
      contactId,
      propertyId: propertyB,
      resolution: "matched_recipient_number",
    });
    expect(replyToB.conversationId).toBeTruthy();
  });

  it("parks ambiguous same-sender replies at contact-level manual triage", async () => {
    const phone = "+18165553002";
    const sender = "+18164870003";
    const contactId = await seedContact(phone);
    const propertyA = await seedProperty(contactId, "3 Ambiguous A Ln");
    const propertyB = await seedProperty(contactId, "4 Ambiguous B Ln");

    await seedOutbound({
      contactId,
      propertyId: propertyA,
      fromAddress: sender,
      toAddress: phone,
      body: "ambiguous outbound a",
    });
    await seedOutbound({
      contactId,
      propertyId: propertyB,
      fromAddress: sender,
      toAddress: phone,
      body: "ambiguous outbound b",
    });

    const resolution = await resolveInboundThread(supabase, phone, sender);

    expect(resolution).toMatchObject({
      contactId,
      propertyId: null,
      resolution: "ambiguous_recipient_number",
    });
    expect(resolution.conversationId).toBeTruthy();
  });

  it("parks ambiguous replies when one property has more than a raw PostgREST page of newer same-sender messages", async () => {
    const phone = "+18165553003";
    const sender = "+18164870004";
    const contactId = await seedContact(phone);
    const propertyA = await seedProperty(contactId, "5 Long History A Ln");
    const propertyB = await seedProperty(contactId, "6 Old History B Ln");

    await seedOutbound({
      contactId,
      propertyId: propertyB,
      fromAddress: sender,
      toAddress: phone,
      body: "older ambiguous outbound b",
      createdAt: "2026-06-01T12:00:00.000Z",
    });
    await seedOutboundBatch(
      Array.from({ length: 1_005 }, (_, i) => ({
        contactId,
        propertyId: propertyA,
        fromAddress: sender,
        toAddress: phone,
        body: `newer long negotiation a ${i}`,
        createdAt: new Date(
          Date.UTC(2026, 5, 2, 12, i, 0),
        ).toISOString(),
      })),
    );

    const resolution = await resolveInboundThread(supabase, phone, sender);

    expect(resolution).toMatchObject({
      contactId,
      propertyId: null,
      resolution: "ambiguous_recipient_number",
    });
    expect(resolution.conversationId).toBeTruthy();
  });
});
