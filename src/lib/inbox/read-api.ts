import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import { retryReceiptTransaction } from "@/lib/messaging/receipt-persistence";
import type { InboxDetailActionFields, InboxDispositionReview } from "./api-contract";

type ReadDatabase = Omit<Database, "public"> & { public: Omit<Database["public"], "Functions"> & { Functions: Database["public"]["Functions"] & {
  inbox_unknown_history_page: { Args: { org_id: string; sender_group_id: string; before_cursor?: string }; Returns: Json };
  inbox_history_page: { Args: { org_id: string; conversation_id: string; before_cursor?: string }; Returns: Json };
  inbox_read_detail: { Args: { org_id: string; conversation_id: string }; Returns: Json };
  inbox_acknowledge_read: { Args: { boundary_id: string; batch_number: number }; Returns: Json };
} } };
export type InboxReadClient = Pick<SupabaseClient<ReadDatabase>, "rpc">;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REVISION = /^(0|[1-9][0-9]{0,18})$/;
export class InboxReadError extends Error {
  constructor(readonly status: number) { super("Inbox read unavailable"); }
}
function requireValue(value: unknown, status = 503): asserts value { if (!value) throw new InboxReadError(status); }
function record(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function id(value: unknown): string { requireValue(typeof value === "string" && UUID.test(value)); return value; }
function revision(value: unknown): string {
  requireValue(typeof value === "string" && REVISION.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
  return value;
}
function timestamp(value: unknown): string { requireValue(typeof value === "string" && Number.isFinite(Date.parse(value))); return value; }
function nullableTimestamp(value: unknown): string | null { return value === null ? null : timestamp(value); }
function nullableIdentifier(value: unknown): string | null { return value === null ? null : id(value); }
function nullableText(value: unknown, maxLength = 2000): string | null {
  requireValue(value === null || (typeof value === "string" && value.length <= maxLength));
  return value as string | null;
}
function booleanValue(value: unknown): boolean { requireValue(typeof value === "boolean"); return value; }
function nullableBoolean(value: unknown): boolean | null { requireValue(value === null || typeof value === "boolean"); return value as boolean | null; }
function detailActionFields(row: Record<string, unknown>): InboxDetailActionFields {
  const reviewId = nullableIdentifier(row.ai_disposition_review_id);
  const review = reviewId === null ? null : (() => {
    requireValue(row.ai_disposition_review_status === "pending");
    const value: InboxDispositionReview = {
      id: reviewId,
      status: "pending",
      disposition: nullableText(row.ai_disposition_review_disposition, 64) ?? "",
      reason: nullableText(row.ai_disposition_review_reason, 4000) ?? "",
      sourceInboundMessageId: id(row.ai_disposition_review_source_inbound_message_id),
      sourceMessageBody: nullableText(row.ai_disposition_review_source_message_body, 16_384),
      createdAt: timestamp(row.ai_disposition_review_created_at),
    };
    requireValue(value.disposition.length > 0 && value.reason.length > 0);
    return value;
  })();
  if (reviewId === null) {
    requireValue(row.ai_disposition_review_status === null && row.ai_disposition_review_disposition === null &&
      row.ai_disposition_review_reason === null && row.ai_disposition_review_source_inbound_message_id === null &&
      row.ai_disposition_review_source_message_body === null && row.ai_disposition_review_created_at === null);
  }
  return {
    propertyId: nullableIdentifier(row.property_id),
    contactId: nullableIdentifier(row.contact_id),
    contactName: nullableText(row.contact_name),
    propertyAddress: nullableText(row.property_address),
    propertyStatus: nullableText(row.property_status, 64),
    outreachDispo: nullableText(row.outreach_dispo, 64),
    assigneeId: nullableIdentifier(row.assignee_id),
    threadCustomerPhone: nullableText(row.thread_customer_phone, 64),
    threadBusinessPhone: nullableText(row.thread_business_phone, 64),
    contactDoNotContact: booleanValue(row.contact_do_not_contact),
    contactSmsOptedOut: booleanValue(row.contact_sms_opted_out),
    phoneSuppressed: nullableBoolean(row.phone_suppressed),
    smsSafetyReadFailed: booleanValue(row.sms_safety_read_failed),
    isDncLocked: booleanValue(row.is_dnc_locked),
    aiDispositionReview: review,
    aiResponderStatus: nullableText(row.ai_responder_status, 128),
    aiResponderReason: nullableText(row.ai_responder_reason, 4000),
    aiResponderStatusAt: nullableTimestamp(row.ai_responder_status_at),
    aiLastDeliveryStatus: nullableText(row.ai_last_delivery_status, 128),
    aiLastDeliveryError: nullableText(row.ai_last_delivery_error, 4000),
  };
}
function fail(error: { code?: string; message?: string } | null): void {
  if (!error) return;
  if (error.code === "PGRST301" || error.code === "PGRST303") throw new InboxReadError(401);
  const message = error.message;
  if (error.code === "42501" && ["INBOX_AUTH_REQUIRED", "INBOX_SESSION_EXPIRED", "INBOX_SESSION_REVOKED"].includes(message ?? "")) throw new InboxReadError(401);
  // Org/membership-scoped denials are access-loss (whole workspace latches permission_lost);
  // item-scoped "not found" denials are benign for a single conversation and must not be
  // conflated with them — matches the same 401/403 split in http-error.ts:11-12 once
  // INBOX_ACCESS_BASELINE_MISSING (a provisioning/backfill gap for an authorized user,
  // not a denial) is excluded and left to fall through to 503 below, same as list/counts.
  if (error.code === "42501" && ["INBOX_ORG_DENIED", "INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING"].includes(message ?? "")) throw new InboxReadError(403);
  if (error.code === "42501" && ["INBOX_READ_NOT_FOUND", "INBOX_ACCESS_DENIED"].includes(message ?? "")) throw new InboxReadError(404);
  if (error.code === "55000" && message === "INBOX_READ_EXPIRED") throw new InboxReadError(410);
  if (error.code === "55000" && ["INBOX_READ_BATCH_CONFLICT", "INBOX_READ_COVERAGE_CHANGED"].includes(message ?? "")) throw new InboxReadError(409);
  if (error.code === "P0001" && message?.startsWith("DNC_LOCKED:")) throw new InboxReadError(409);
  throw new InboxReadError(503);
}
export function createInboxReadRepository(client: InboxReadClient) {
  return {
    async unknownHistory(orgId: string, senderGroupId: string, signal: AbortSignal, beforeCursor?: string) {
      requireValue(UUID.test(orgId) && UUID.test(senderGroupId) && (beforeCursor === undefined || UUID.test(beforeCursor)), 400);
      signal.throwIfAborted();
      const { data, error } = await client.rpc("inbox_unknown_history_page", { org_id: orgId, sender_group_id: senderGroupId, ...(beforeCursor ? { before_cursor: beforeCursor } : {}) }).abortSignal(signal);
      signal.throwIfAborted(); fail(error);
      const row = record(data);
      requireValue(row.org_id === orgId && row.sender_group_id === senderGroupId && typeof row.raw_sender === "string" && row.raw_sender.length > 0 && Array.isArray(row.history) && row.history.length <= 50);
      const seen = new Set<string>();
      const history = row.history.map(value => {
        const message = record(value), messageId = id(message.id);
        requireValue(!seen.has(messageId)); seen.add(messageId);
        requireValue(message.body === null || typeof message.body === "string");
        requireValue(message.direction === "inbound" || message.direction === "outbound");
        return { id: messageId, createdAtRaw: timestamp(message.created_at_raw), body: message.body,
          direction: message.direction, dismissedAtRaw: nullableTimestamp(message.dismissed_at_raw) };
      });
      return { requesterId: id(row.requester_id), orgId, senderGroupId, rawSender: row.raw_sender,
        expiresAt: timestamp(row.expires_at), history, nextCursor: row.next_cursor === null ? null : id(row.next_cursor) };
    },
    async detail(orgId: string, conversationId: string, signal: AbortSignal, beforeCursor?: string) {
      requireValue(UUID.test(orgId) && UUID.test(conversationId) && (beforeCursor === undefined || UUID.test(beforeCursor)), 400);
      signal.throwIfAborted();
      const { data, error } = await client.rpc("inbox_history_page", { org_id: orgId, conversation_id: conversationId, ...(beforeCursor ? { before_cursor: beforeCursor } : {}) }).abortSignal(signal);
      signal.throwIfAborted();
      fail(error);
      const row = record(data);
      requireValue(row.org_id === orgId && row.conversation_id === conversationId && Array.isArray(row.history) && row.history.length <= 50);
      const seen = new Set<string>();
      const history = row.history.map(value => {
        const message = record(value), messageId = id(message.id);
        requireValue(!seen.has(messageId)); seen.add(messageId);
        requireValue(message.body === null || typeof message.body === "string");
        requireValue(message.direction === "inbound" || message.direction === "outbound");
        return { id: messageId, createdAtRaw: timestamp(message.created_at_raw), body: message.body,
          direction: message.direction, readAtRaw: nullableTimestamp(message.read_at_raw), inboundRevision: revision(message.inbound_revision) };
      });
      return { requesterId: id(row.requester_id), orgId, conversationId, headRevision: revision(row.head_revision),
        readBoundary: id(row.read_boundary), boundaryExpiresAt: timestamp(row.boundary_expires_at), captureGeneration: id(row.capture_generation),
        ...detailActionFields(row), history, nextCursor: row.next_cursor === null ? null : id(row.next_cursor) };
    },
    async acknowledge(boundaryId: string, batch: number, signal: AbortSignal) {
      requireValue(UUID.test(boundaryId) && Number.isSafeInteger(batch) && batch >= 0 && batch <= 2147483647, 400);
      // The RPC is the entire SQL transaction. Only explicit PostgreSQL aborted-
      // transaction codes retry. A thrown/lost response is recovered by the same
      // boundary/batch identity; it must never silently advance the batch number.
      const { data, error } = await retryReceiptTransaction(() => {
        signal.throwIfAborted();
        return client.rpc("inbox_acknowledge_read", { boundary_id: boundaryId, batch_number: batch }).abortSignal(signal);
      });
      signal.throwIfAborted();
      fail(error);
      const row = record(data);
      requireValue(row.boundary_id === boundaryId && row.batch === batch && typeof row.completed === "boolean" &&
        Number.isInteger(row.changed) && (row.changed as number) >= 0 && (row.changed as number) <= 200);
      return { boundaryId, batch, changed: row.changed as number, completed: row.completed };
    },
  };
}
