import { describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/types";

import { messageBelongsToThread } from "./messages-thread";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

function makeMessage(
  overrides: Partial<MessageRow> & { id: string },
): MessageRow {
  return {
    id: overrides.id,
    channel: "sms",
    direction: overrides.direction ?? "inbound",
    status: overrides.status ?? "received",
    contact_id: overrides.contact_id ?? "contact-1",
    property_id: overrides.property_id ?? "property-1",
    conversation_id: overrides.conversation_id ?? null,
    body: overrides.body ?? "hello",
    from_address: overrides.from_address ?? "+15551234567",
    to_address: overrides.to_address ?? "+18165550000",
    created_at: overrides.created_at ?? "2026-06-09T12:00:00.000Z",
    read_at: overrides.read_at ?? null,
    metadata: overrides.metadata ?? null,
  } as MessageRow;
}

describe("messageBelongsToThread", () => {
  it("uses conversation id as the only match key when the thread has one", () => {
    const activeConversation = "11111111-1111-4111-8111-111111111111";
    const siblingConversation = "22222222-2222-4222-8222-222222222222";

    const matching = makeMessage({
      id: "m1",
      contact_id: "contact-1",
      property_id: "property-1",
      conversation_id: activeConversation,
    });
    const sibling = makeMessage({
      id: "m2",
      contact_id: "contact-1",
      property_id: "property-1",
      conversation_id: siblingConversation,
    });

    expect(
      messageBelongsToThread(matching, {
        contactId: "contact-1",
        propertyId: "property-1",
        conversationId: activeConversation,
      }),
    ).toBe(true);
    expect(
      messageBelongsToThread(sibling, {
        contactId: "contact-1",
        propertyId: "property-1",
        conversationId: activeConversation,
      }),
    ).toBe(false);
  });

  it("falls back to property/contact matching for legacy threads without a conversation id", () => {
    const legacyRow = makeMessage({
      id: "m3",
      contact_id: "contact-9",
      property_id: "property-9",
      conversation_id: null,
    });

    expect(
      messageBelongsToThread(legacyRow, {
        contactId: "contact-9",
        propertyId: "property-9",
        conversationId: null,
      }),
    ).toBe(true);
  });
});
