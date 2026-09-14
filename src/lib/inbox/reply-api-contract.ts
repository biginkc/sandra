/** Proposed wire contract for the disabled reviewed bulk-reply boundary.
 * Types do not enable an endpoint or establish authorization. All returned
 * values must be parsed against the authoritative frozen database snapshot. */
export interface InboxReplyTarget { kind: "conversation" | "unknown_sender_group"; id: string }
export type InboxReplyExclusion =
  | "unsupported_target" | "conversation_unavailable" | "property_unavailable"
  | "property_suppressed" | "contact_mapping_unavailable" | "contact_suppressed"
  | "inbound_unavailable" | "conversation_changed" | "inbound_mapping_changed"
  | "reply_route_unavailable" | "phone_not_saved" | "landline"
  /** Saved slot exists but is not affirmatively 'mobile' (e.g. never
   * classified). Fails closed like landline — v1 has no bulk-queue-style
   * operator opt-in toggle for unknown line types. */
  | "unclassified_phone"
  | "sms_suppressed"
  /** No affirmative opt-in event on file. Deliberately stricter than
   * send.ts/bulk-queue.ts, which let a no-consent contact through as long
   * as they haven't explicitly opted out — this boundary has no per-message
   * human review at send time, so it requires affirmative consent instead. */
  | "no_consent"
  | "sender_unavailable" | "context_unavailable" | "conversation_window_expired"
  | "unknown_state" | "outside_window" | "missing_variable" | "invalid_template"
  | "invalid_body";
/** Single source of truth for the D5 bulk-reply recipient cap. Must stay in
 * parity with inbox_reply_preparation.recipient_limit() in
 * experiments/inbox-reply-preparation/recipient.sql — checked by
 * reply-api-contract.test.ts, which reads that SQL source directly. */
export const INBOX_REPLY_RECIPIENT_LIMIT = 50;
export interface InboxReplyPrepareRequest {
  targets: readonly InboxReplyTarget[];
  template: string;
  idempotencyKey: string;
}
export interface PreparedInboxReplyItem {
  id: string;
  target: InboxReplyTarget;
  exclusion: InboxReplyExclusion | null;
  /** Present only for a canonically eligible, successfully rendered recipient. */
  recipient: null | {
    contactName: string;
    propertyAddress: string;
    propertyId: string;
    contactId: string;
    from: string;
    to: string;
    renderedBody: string;
  };
  /** True on every involved item; no automatic winner or duplicate send. */
  duplicateDestination: boolean;
}
export interface PreparedInboxReply {
  preparationId: string;
  idempotencyKey: string;
  inputHash: string;
  expiresAt: string;
  items: readonly PreparedInboxReplyItem[];
  recipientCount: number;
  blockers: readonly ("empty" | "recipient_limit" | "duplicate_destination")[];
}
/** Excluding an item produces a fresh preparation/key and review. Acceptance
 * cannot replace text, change routes, or alter the old frozen recipient set. */
export interface AcceptInboxReplyRequest { preparationId: string; idempotencyKey: string }
export interface AcceptedInboxReply extends AcceptInboxReplyRequest { operationId: string }
export type InboxReplyReceiptState =
  | "pending" | "blocked" | "dispatch_started" | "uncertain"
  | "provider_accepted" | "delivered" | "delivery_failed"
  /** D3-unreachable in v1: no dispatch worker/provider adapter exists yet
   * (PRs B–H). Kept in the vocabulary now so a future terminal-rejection
   * receipt state doesn't require a wire-contract/consumer migration later. */
  | "rejected_unsent" | "confirmed_not_submitted";
export interface InboxReplyReceipt {
  itemId: string;
  attemptId: string | null;
  version: string;
  state: InboxReplyReceiptState;
  reason: string | null;
}
export interface InboxReplyStatus {
  operationId: string;
  preparationId: string;
  /** Completed dispatch work may still include uncertainty or pending delivery. */
  dispatchComplete: boolean;
  /** Requester-authorized frozen snapshot, including after reload. Never persist
   * message bodies in local/session storage to reconstruct this mapping. */
  items: readonly PreparedInboxReplyItem[];
  receipts: readonly InboxReplyReceipt[];
}
/** prepared permits only another request with the SAME pair. It is not a
 * guarantee that a racing acceptance cannot commit, or permission for a new key. */
export type InboxReplyRecovery =
  | { state: "accepted"; operation: AcceptedInboxReply }
  | { state: "prepared"; preparationId: string; idempotencyKey: string }
  | { state: "expired_not_accepted"; preparationId: string; idempotencyKey: string };
