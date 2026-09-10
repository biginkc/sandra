import { expect, it } from "vitest";
import { detailSafetySubscriptions } from "./use-detail-reconciliation";
import type { InboxDetail } from "./inbox-detail-data";

it("covers each independent authoritative safety source with scoped keys", () => {
  const subscriptions = detailSafetySubscriptions({
    contactId: "contact", conversationId: "conversation", propertyId: "property", threadCustomerPhone: "+18165551234",
  } as InboxDetail, "viewer");
  expect(subscriptions).toEqual([
    { table: "contacts", filter: "id=eq.contact" },
    { table: "consent_events", filter: "contact_id=eq.contact" },
    { table: "message_threads", filter: "conversation_id=eq.conversation" },
    { table: "ai_disposition_reviews", filter: "conversation_id=eq.conversation" },
    { table: "properties", filter: "id=eq.property" },
    { table: "sms_phone_suppressions", filter: "phone_e164=eq.+18165551234" },
    { table: "memberships", filter: "user_id=eq.viewer" },
  ]);
});
