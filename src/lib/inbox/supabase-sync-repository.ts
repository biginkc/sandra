import "server-only";
import { inboxCountNames, type InboxFilter, type InboxCounts } from "./filter-contract";
import { InboxHttpError, inboxDatabaseError } from "./http-error";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json, Database } from "@/lib/supabase/types";
import type { DurableInboxScope, InboxSession, InboxSyncTarget, InboxWorksetRepository } from "./sync-gateway";

type InboxDatabase = Omit<Database, "public"> & { public: Omit<Database["public"], "Functions"> & { Functions: Database["public"]["Functions"] & {
  inbox_authorize_sync: { Args: { org_id: string | null }; Returns: Json };
  inbox_create_workset_v2: { Args: { org_id: string; filter: Json; limit: number; replaces_scope_id: string | null; cursor_id: string | null }; Returns: Json };
  inbox_counts_v2: { Args: { org_id: string; filter: Json }; Returns: Json };
  inbox_get_sync_scope: { Args: { scope_id: string }; Returns: Json };
  inbox_bind_sync_handle: { Args: { scope_id: string; partition_index: number; expected_handle: string | null; next_handle: string }; Returns: boolean };
} } };
export type InboxRpcClient = Pick<SupabaseClient<InboxDatabase>, "rpc">;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const unavailable = () => new Error("Inbox authority unavailable");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string { if (typeof value !== "string" || !uuid.test(value)) throw unavailable(); return value; }
function text(value: unknown): string { if (typeof value !== "string" || value.length === 0) throw unavailable(); return value; }
function expiry(value: unknown): number { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw unavailable(); return Date.parse(value); }
function scope(value: unknown): DurableInboxScope | null {
  if (value === null) return null;
  const row = object(value);
  if (!Array.isArray(row.targets) || row.targets.length > 500 || (!Array.isArray(row.handles) || row.handles.length !== Math.max(1, Math.ceil(row.targets.length / 100)) || row.handles.some(handle => handle !== null && (typeof handle !== "string" || handle.length > 256)))) throw unavailable();
  const keys = new Set<string>();
  const targets = row.targets.map((value): InboxSyncTarget => {
    const target = object(value);
    if (target.kind !== "known_conversation" && target.kind !== "unknown_sender") throw unavailable();
    const id = identifier(target.id), key = `${target.kind}:${id}`;
    if (keys.has(key)) throw unavailable();
    keys.add(key);
    return { kind: target.kind, id };
  });
  return { id: identifier(row.id), orgId: identifier(row.org_id), userId: identifier(row.user_id), sessionId: identifier(row.session_id), accessEpoch: text(row.access_epoch),
    generation: text(row.generation), expiresAt: expiry(row.expires_at), ...(row.created_at === undefined ? {} : { createdAt: expiry(row.created_at) }), targets, handles: row.handles as (string | null)[] };
}

/** Request-scoped cookie client only. Never supply an admin client: the four SQL wrappers
 * independently validate JWT user/session and current canonical organization access.
 * Missing RPCs/grants throw; there is no local scope cache, service-role retry or invented epoch.
 */
export interface InboxDataRepository extends InboxWorksetRepository {
  getContext(signal: AbortSignal): Promise<{ userId: string; sessionId: string; orgId: string; accessEpoch: string; expiresAt: number }>;
  getCounts(session: InboxSession, orgId: string, filter: InboxFilter, signal: AbortSignal): Promise<InboxCounts>;
}
export function createSupabaseInboxRepository(client: InboxRpcClient): InboxDataRepository {
  async function authorize(orgId: string | null, signal: AbortSignal) {
    signal.throwIfAborted();
    const { data, error } = await client.rpc("inbox_authorize_sync", { org_id: orgId }).abortSignal(signal);
    signal.throwIfAborted();
    if (error) throw inboxDatabaseError(error);
    const row = object(data);
    if (row.session_active !== true || row.active_membership_count !== 1) throw unavailable();
    return { userId: identifier(row.user_id), sessionId: identifier(row.session_id), orgId: identifier(row.org_id), epoch: text(row.access_epoch), expiresAt: expiry(row.expires_at) };
  }
  const same = (actual: InboxSession, expected: InboxSession) => actual.userId === expected.userId && actual.sessionId === expected.sessionId;
  return {
    async getContext(signal) { const value = await authorize(null, signal); return { userId: value.userId, sessionId: value.sessionId, orgId: value.orgId, accessEpoch: value.epoch, expiresAt: value.expiresAt }; },
    async authenticate(_request, signal) { return authorize(null, signal); },
    async getAccess(session, orgId, signal) {
      const current = await authorize(orgId, signal);
      if (!same(current, session) || current.orgId !== orgId) return null;
      return { sessionActive: true, activeMembershipCount: 1, status: "active", epoch: current.epoch, expiresAt: current.expiresAt, deletionPrepared: false };
    },
    async getCounts(session, orgId, filter, signal) {
      const before = await authorize(orgId, signal);
      if (!same(before, session) || before.orgId !== orgId) throw new InboxHttpError(403);
      const { data, error } = await client.rpc("inbox_counts_v2", { org_id: orgId, filter }).abortSignal(signal);
      signal.throwIfAborted();
      if (error) throw inboxDatabaseError(error);
      const row = object(data), counts = object(row.counts), epoch = text(row.access_epoch);
      expiry(row.as_of);
      if (Object.keys(counts).length !== inboxCountNames.length || inboxCountNames.some(key => !Number.isSafeInteger(counts[key]) || (counts[key] as number) < 0)) throw unavailable();
      const after = await authorize(orgId, signal);
      if (!same(after, session) || after.orgId !== orgId || before.epoch !== epoch || after.epoch !== epoch || after.expiresAt <= Date.now()) throw new InboxHttpError(403);
      return { counts: counts as InboxCounts["counts"], asOf: row.as_of as string, accessEpoch: epoch };
    },
    async getScope(id, signal) {
      signal.throwIfAborted();
      const { data, error } = await client.rpc("inbox_get_sync_scope", { scope_id: id }).abortSignal(signal);
      signal.throwIfAborted();
      if (error) throw inboxDatabaseError(error);
      return scope(data);
    },
    async createScope(session, request, signal) {
      if (request.cursor !== null && !uuid.test(request.cursor)) throw new InboxHttpError(400);
      const current = await authorize(request.orgId, signal);
      if (!same(current, session) || current.orgId !== request.orgId) throw unavailable();
      const { data, error } = await client.rpc("inbox_create_workset_v2", { org_id: request.orgId, filter: request.filter as Json, limit: request.limit, replaces_scope_id: request.replacesScopeId ?? null, cursor_id: request.cursor }).abortSignal(signal);
      signal.throwIfAborted();
      if (error) throw inboxDatabaseError(error);
      const created = scope(data);
      if (!created || !same(created, session) || created.orgId !== request.orgId) throw unavailable();
      const metadata = object(data);
      if (metadata.next_cursor !== null && (typeof metadata.next_cursor !== "string" || !uuid.test(metadata.next_cursor))) throw unavailable();
      if (typeof metadata.refreshed !== "boolean") throw unavailable();
      return { ...created, createdAt: expiry(metadata.created_at), nextCursor: metadata.next_cursor as string | null, refreshed: metadata.refreshed };
    },
    async bindHandle(expected, partitionIndex, expectedHandle, nextHandle, signal) {
      const current = await authorize(expected.orgId, signal);
      if (!same(current, expected) || current.orgId !== expected.orgId || current.epoch !== expected.accessEpoch) return false;
      const { data, error } = await client.rpc("inbox_bind_sync_handle", { scope_id: expected.id, partition_index: partitionIndex, expected_handle: expectedHandle, next_handle: nextHandle }).abortSignal(signal);
      signal.throwIfAborted();
      if (error) throw inboxDatabaseError(error);
      return data === true;
    },
  };
}
