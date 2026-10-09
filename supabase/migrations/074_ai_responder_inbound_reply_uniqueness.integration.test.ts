import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();

async function seedLead(): Promise<{ contactId: string; propertyId: string }> {
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      first_name: "AI",
      last_name: "Unique",
      phone_1: `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  expect(contactError).toBeNull();

  const { data: property, error: propertyError } = await supabase
    .from("properties")
    .insert({
      address: `074 Reply Guard ${crypto.randomUUID()}`,
      state: "MO",
      status: "new_lead",
      homeowner_contact_id: contact!.id,
    })
    .select("id")
    .single();
  expect(propertyError).toBeNull();

  return { contactId: contact!.id, propertyId: property!.id };
}

describe("Migration 074 — AI inbound reply uniqueness", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("rejects a second AI outbound row for the same inbound message id", async () => {
    const { contactId, propertyId } = await seedLead();
    const inboundMessageId = "88888888-8888-4888-8888-888888888888";

    const first = await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      contact_id: contactId,
      property_id: propertyId,
      body: "first AI reply",
      metadata: {
        generated_by: "ai_responder_v1",
        inbound_message_id: inboundMessageId,
        model: "claude-haiku-4-5-20251001",
        confidence: 0.9,
        sentiment: "positive",
        turn: 1,
      },
    });
    const duplicate = await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      contact_id: contactId,
      property_id: propertyId,
      body: "duplicate AI reply",
      metadata: {
        generated_by: "ai_responder_v1",
        inbound_message_id: inboundMessageId,
        model: "claude-haiku-4-5-20251001",
        confidence: 0.8,
        sentiment: "neutral",
        turn: 2,
      },
    });

    expect(first.error).toBeNull();
    expect(duplicate.error?.code).toBe("23505");
    expect(duplicate.error?.message).toContain(
      "idx_messages_ai_responder_inbound_unique",
    );
  });

  it("a refused submission's retired row (generated_by kept, inbound key renamed to aborted_inbound_message_id) never collides with the retry's row", async () => {
    const { contactId, propertyId } = await seedLead();
    const inboundMessageId = "99999999-9999-4999-8999-999999999999";
    const retired = {
      generated_by: "ai_responder_v1",
      aborted_inbound_message_id: inboundMessageId,
      abortedBeforeProvider: true,
    };
    const row = (status: string, metadata: Record<string, string | boolean>) => ({
      channel: "sms",
      direction: "outbound",
      status,
      contact_id: contactId,
      property_id: propertyId,
      body: "ai",
      metadata,
    });
    const first = await supabase.from("messages").insert(row("failed", retired));
    const second = await supabase.from("messages").insert(row("failed", retired));
    const retry = await supabase
      .from("messages")
      .insert(row("sent", { generated_by: "ai_responder_v1", inbound_message_id: inboundMessageId }));
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(retry.error).toBeNull();
  });
});
