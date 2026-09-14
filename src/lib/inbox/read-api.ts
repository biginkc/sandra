import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import { retryReceiptTransaction } from "@/lib/messaging/receipt-persistence";

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
function fail(error: { code?: string; message?: string } | null): void {
  if (!error) return;
  if (error.code === "PGRST301" || error.code === "PGRST303") throw new InboxReadError(401);
  const message = error.message;
  if (error.code === "42501" && ["INBOX_AUTH_REQUIRED", "INBOX_SESSION_EXPIRED", "INBOX_SESSION_REVOKED"].includes(message ?? "")) throw new InboxReadError(401);
  if (error.code === "42501" && ["INBOX_READ_NOT_FOUND", "INBOX_ACCESS_DENIED", "INBOX_ORG_DENIED", "INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING"].includes(message ?? "")) throw new InboxReadError(404);
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
        readBoundary: id(row.read_boundary), boundaryExpiresAt: timestamp(row.boundary_expires_at), captureGeneration: id(row.capture_generation), history, nextCursor: row.next_cursor === null ? null : id(row.next_cursor) };
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
