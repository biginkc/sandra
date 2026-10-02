import { INBOX_REPLY_EXCLUSIONS, INBOX_REPLY_RECIPIENT_LIMIT, type InboxReplyExclusion } from "@/lib/inbox/reply-api-contract";

export type InboxReplyPreviewState = "ready" | "checking" | "reviewing" | "sending" | "sent" | "receipt-blocked" | "receipt-confirmed-not-submitted" | "route-changed" | "uncertain" | "network-error" | "bulk-review" | "bulk-receipt" | `blocked-${InboxReplyExclusion}`;
export const blockedPreviewStates = [...INBOX_REPLY_EXCLUSIONS].map(value => `blocked-${value}` as const);
export const previewStates: InboxReplyPreviewState[] = ["ready", "checking", "reviewing", "sending", "sent", "receipt-blocked", "receipt-confirmed-not-submitted", "route-changed", "uncertain", "network-error", ...blockedPreviewStates, "bulk-review", "bulk-receipt"];
export const recipientLimit = INBOX_REPLY_RECIPIENT_LIMIT;

export const fixture = {
  orgId: "11111111-1111-4111-8111-111111111111",
  requesterId: "22222222-2222-4222-8222-222222222222",
  conversationId: "33333333-3333-4333-8333-333333333333",
  secondConversationId: "88888888-8888-4888-8888-888888888888",
  boundaryId: "44444444-4444-4444-8444-444444444444",
  captureGeneration: "55555555-5555-4555-8555-555555555555",
  name: "Dana Whitfield",
  secondName: "Marcus Oyelaran",
  property: "Larkspur Ct",
  secondProperty: "Pinehurst Dr",
  from: "+18165550100",
  secondFrom: "+18165550101",
  to: "+18165550142",
  secondTo: "+18165550143",
  body: "Hi Dana, thanks for getting back about Larkspur Ct. When is a good time for a quick call this week?",
  secondBody: "Hi Marcus, thanks for getting back about Pinehurst Dr. When is a good time for a quick call this week?",
  history: [
    { id: "77777777-7777-4777-8777-777777777777", createdAtRaw: "2026-09-29T14:05:00Z", body: "I might be. What would a call involve?", direction: "inbound" as const, readAtRaw: null, inboundRevision: "2", status: "received", delivery: "delivered" as const },
    { id: "66666666-6666-4666-8666-666666666666", createdAtRaw: "2026-09-29T14:02:00Z", body: "Hi Dana, are you still considering an offer for Larkspur Ct?", direction: "outbound" as const, readAtRaw: null, inboundRevision: "1", status: "sent", delivery: "delivered" as const },
  ],
} as const;

export function isPreviewState(value: string): value is InboxReplyPreviewState { return previewStates.includes(value as InboxReplyPreviewState); }
