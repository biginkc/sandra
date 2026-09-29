import type { InboxDetail } from "@/app/(dashboard)/messages/inbox-detail-data";
import type { Thread } from "@/lib/messages/list-threads";
import type { Database } from "@/lib/supabase/types";

const at = "2026-09-26T14:00:00.000Z";
const orgId = "00000000-0000-4000-8000-000000000001";
const propertyId = "00000000-0000-4000-8000-000000000002";
const contactId = "00000000-0000-4000-8000-000000000003";
const conversationId = "00000000-0000-4000-8000-000000000004";

function message(id: string, body: string, direction: "inbound" | "outbound", createdAt: string): Database["public"]["Tables"]["messages"]["Row"] {
  return {
    id, org_id: orgId, property_id: propertyId, contact_id: contactId, conversation_id: conversationId,
    channel: "sms", direction, body, status: direction === "inbound" ? "received" : "delivered",
    created_at: createdAt, read_at: direction === "inbound" ? createdAt : null,
    from_address: direction === "inbound" ? "+18165550142" : "+18165550100",
    to_address: direction === "inbound" ? "+18165550100" : "+18165550142",
    metadata: null,
  } as Database["public"]["Tables"]["messages"]["Row"];
}

export const brandMessages = [
  message("00000000-0000-4000-8000-000000000011", "Hi Marisol, it's Jarrad with BMH. Still thinking about 4127 Hollister Ave? Happy to answer any questions, no pressure. Reply STOP to opt out.", "outbound", "2026-09-17T14:02:00.000Z"),
  message("00000000-0000-4000-8000-000000000012", "Hi Marisol, checking back on 4127 Hollister Ave. If the timing has changed, I can put together a fresh number for you this week. Reply STOP to opt out.", "outbound", "2026-09-24T14:00:00.000Z"),
  message("00000000-0000-4000-8000-000000000013", "Still here. What kind of number are we talking? House needs a roof.", "inbound", "2026-09-26T23:41:00.000Z"),
];

export const brandThread = {
  threadId: conversationId, contactId, contactName: "Marisol Vega", contactPhone: "+18165550142",
  threadCustomerPhone: "+18165550142", threadBusinessPhone: "+18165550100",
  propertyId, propertyAddress: "4127 Hollister Ave, Kansas City, MO", propertyStatus: "prospect",
  outreachDispo: "needs_sequence", dripName: "Quiet owner check-in", dripStep: 2, dripStepsTotal: 4, dripReplied: true,
  aiDispositionReview: null, isDncLocked: false, assigneeId: null, lastMessageBody: brandMessages[2].body,
  lastMessageDirection: "inbound", lastMessageAt: "2026-09-26T23:41:00.000Z", unreadCount: 1,
  needsHumanAttention: false, escalationReason: null, isOptedOut: false, isTestTraffic: false,
  needsOutcome: false, aiResponderStatus: null, aiResponderReason: null, aiResponderStatusAt: null,
  aiLastDeliveryStatus: null, aiLastDeliveryError: null,
} satisfies Thread;

export const brandDetail: InboxDetail = {
  threadId: conversationId, conversationId, contactId, contactName: "Marisol Vega",
  threadCustomerPhone: "+18165550142", threadBusinessPhone: "+18165550100", contactPhone: "+18165550142",
  replyToPhone: "+18165550142", replyToPhoneLineType: "mobile", propertyId,
  propertyAddress: "4127 Hollister Ave, Kansas City, MO", homeownerContactId: contactId, agentContactId: null,
  assigneeId: null, propertyStatus: "prospect", outreachDispo: "needs_sequence", aiDispositionReview: null,
  contactDoNotContact: false, contactSmsOptedOut: false, smsConsentState: "can_send_marketing",
  phoneSuppressed: false, smsSafetyReadFailed: false, isDncLocked: false,
  drip: { enrollmentId: "00000000-0000-4000-8000-000000000005", sequenceId: "00000000-0000-4000-8000-000000000006", name: "Quiet owner check-in", step: 2, total: 4, replied: true, stoppedAt: "2026-09-26T23:41:00.000Z" },
  dripMessageLabels: {
    [brandMessages[0].id]: "Drip · Quiet owner check-in · text 1 of 4",
    [brandMessages[1].id]: "Drip · Quiet owner check-in · text 2 of 4",
  },
  dripReplyMessageIds: [brandMessages[2].id],
  initialMessages: brandMessages,
};

export const brandCantStartDetail: InboxDetail = {
  ...brandDetail,
  drip: { enrollmentId: "00000000-0000-4000-8000-000000000005", sequenceId: "00000000-0000-4000-8000-000000000007", name: "Current seller check-in", step: 1, total: 3, replied: false, status: "active", stoppedAt: null },
  dripMessageLabels: {}, dripReplyMessageIds: [], initialMessages: [brandMessages[0]],
};

export const brandTimestamp = Date.parse(at);
