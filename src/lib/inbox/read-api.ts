import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import { retryReceiptTransaction } from "@/lib/messaging/receipt-persistence";
import type { InboxDripContext } from "./drip-context";
import { labelsFromDripInput } from "./drip-context";

type ReadDatabase = Omit<Database, "public"> & { public: Omit<Database["public"], "Functions"> & { Functions: Database["public"]["Functions"] & {
  inbox_unknown_history_page: { Args: { org_id: string; sender_group_id: string; before_cursor?: string }; Returns: Json };
  inbox_history_page: { Args: { org_id: string; conversation_id: string; before_cursor?: string }; Returns: Json };
  inbox_read_detail: { Args: { org_id: string; conversation_id: string }; Returns: Json };
  inbox_acknowledge_read: { Args: { boundary_id: string; batch_number: number }; Returns: Json };
  inbox_drip_label_inputs_v1: { Args: { org_id: string; conversation_id: string; message_ids: string[] }; Returns: Json };
} } };
export type InboxReadClient = Pick<SupabaseClient<ReadDatabase>, "rpc">;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REVISION = /^(0|[1-9][0-9]{0,18})$/;
// The label RPC deliberately caps input at 50 IDs; the canonical history page is also capped at 50.
export class InboxReadError extends Error {
  constructor(readonly status: number) { super("Inbox read unavailable"); }
}
function requireValue(value: unknown, status = 503): asserts value { if (!value) throw new InboxReadError(status); }
function record(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function id(value: unknown): string { requireValue(typeof value === "string" && UUID.test(value)); return value; }
function nullableId(value: unknown): string | null { return value === null ? null : id(value); }
function revision(value: unknown): string {
  requireValue(typeof value === "string" && REVISION.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
  return value;
}
function timestamp(value: unknown): string { requireValue(typeof value === "string" && Number.isFinite(Date.parse(value))); return value; }
function nullableTimestamp(value: unknown): string | null { return value === null ? null : timestamp(value); }
function historyStatus(value: unknown): string { requireValue(typeof value === "string" && value.length > 0); return value; }
function text(value: unknown): string { requireValue(typeof value === "string" && value.length > 0); return value; }
function delivery(value: unknown): "sending" | "sent" | "delivered" | "failed" | "not_confirmed" {
  requireValue(typeof value === "string" && ["sending", "sent", "delivered", "failed", "not_confirmed"].includes(value));
  return value as "sending" | "sent" | "delivered" | "failed" | "not_confirmed";
}
function dripContext(value: unknown): InboxDripContext["drip"] {
  if (value === undefined || value === null) return null;
  const row = record(value);
  requireValue(typeof row.enrollmentId === "string" && UUID.test(row.enrollmentId));
  requireValue(typeof row.sequenceId === "string" && UUID.test(row.sequenceId));
  requireValue(typeof row.name === "string" && row.name.length > 0);
  requireValue(Number.isSafeInteger(row.step) && (row.step as number) >= 0);
  requireValue(Number.isSafeInteger(row.total) && (row.total as number) >= 0);
  requireValue(typeof row.replied === "boolean");
  requireValue(row.status === undefined || row.status === "active" || row.status === "paused" || row.status === "completed");
  requireValue(row.timeZone === undefined || typeof row.timeZone === "string");
  requireValue(row.stoppedAt === null || row.stoppedAt === undefined || typeof row.stoppedAt === "string");
  return {
    enrollmentId: row.enrollmentId as string,
    sequenceId: row.sequenceId as string,
    name: row.name as string,
    step: row.step as number,
    total: row.total as number,
    replied: row.replied as boolean,
    ...(row.status === undefined ? {} : { status: row.status as "active" | "paused" | "completed" }),
    ...(row.timeZone === undefined ? {} : { timeZone: row.timeZone as string }),
    stoppedAt: row.stoppedAt === undefined ? null : row.stoppedAt as string | null,
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
  if (error.code === "42501" && ["INBOX_ORG_DENIED", "INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING", "INBOX_ACCESS_CHANGED"].includes(message ?? "")) throw new InboxReadError(403);
  if (error.code === "22023" && message === "INBOX_INVALID_LABEL_INPUTS") throw new InboxReadError(400);
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
          direction: message.direction, readAtRaw: nullableTimestamp(message.read_at_raw), inboundRevision: revision(message.inbound_revision),
          status: historyStatus(message.status), delivery: delivery(message.delivery) };
      });
      const historyDirections = new Map(history.map(message => [message.id, message.direction]));
      const { data: labelsData, error: labelsError } = await client.rpc("inbox_drip_label_inputs_v1", {
        org_id: orgId, conversation_id: conversationId, message_ids: history.map(message => message.id),
      }).abortSignal(signal);
      signal.throwIfAborted(); fail(labelsError);
      const labelsRow = record(labelsData), labels = new Map<string, { dripLabel: string | null; dripReplyLabel: string | null }>();
      requireValue(labelsRow.org_id === orgId && labelsRow.conversation_id === conversationId && Array.isArray(labelsRow.messages) && labelsRow.messages.length <= history.length + 1);
      for (const value of labelsRow.messages) {
        const label = record(value), messageId = id(label.id);
        if (label.is_page !== true) continue;
        const direction = historyDirections.get(messageId);
        requireValue(direction === "inbound" || direction === "outbound");
        const dripName = label.drip_name === undefined || label.drip_name === null ? null : text(label.drip_name);
        const dripStep = label.drip_step === undefined || label.drip_step === null ? null : label.drip_step;
        const dripStepsTotal = label.drip_steps_total === undefined || label.drip_steps_total === null ? null : label.drip_steps_total;
        const previousDripStep = label.previous_drip_step === undefined || label.previous_drip_step === null ? null : label.previous_drip_step;
        for (const value of [dripStep, dripStepsTotal, previousDripStep]) {
          if (value !== null) requireValue(Number.isSafeInteger(value) && (value as number) > 0);
        }
        labels.set(messageId, labelsFromDripInput({
          dripName,
          dripStep: dripStep as number | null,
          dripStepsTotal: dripStepsTotal as number | null,
          previousDripStep: previousDripStep as number | null,
        }, direction));
      }
      const labeledHistory = history.map(message => {
        const label = labels.get(message.id);
        return { ...message, ...(label?.dripLabel ? { dripLabel: label.dripLabel } : {}), ...(label?.dripReplyLabel ? { dripReplyLabel: label.dripReplyLabel } : {}) };
      });
      return { requesterId: id(row.requester_id), orgId, conversationId, propertyId: row.property_id === undefined ? null : nullableId(row.property_id), headRevision: revision(row.head_revision),
        readBoundary: id(row.read_boundary), boundaryExpiresAt: timestamp(row.boundary_expires_at), captureGeneration: id(row.capture_generation), history: labeledHistory,
        ...(row.drip === undefined ? {} : { drip: dripContext(row.drip) }), nextCursor: row.next_cursor === null ? null : id(row.next_cursor) };
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
