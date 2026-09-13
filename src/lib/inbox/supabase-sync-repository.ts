import "server-only";
import { InboxHttpError, inboxDatabaseError } from "./http-error";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json, Database } from "@/lib/supabase/types";
import type { DurableInboxScope, InboxSession, InboxSyncTarget, InboxWorksetRepository } from "./sync-gateway";

type InboxDatabase = Omit<Database, "public"> & { public: Omit<Database["public"], "Functions"> & { Functions: Database["public"]["Functions"] & {
  inbox_authorize_sync: { Args: { org_id: string | null }; Returns: Json };
  inbox_create_workset: { Args: { org_id: string; filter: Json; limit: number; replaces_scope_id: string | null }; Returns: Json };
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
    generation: text(row.generation), expiresAt: expiry(row.expires_at), targets, handles: row.handles as (string | null)[] };
}

/** Request-scoped cookie client only. Never supply an admin client: the four SQL wrappers
 * independently validate JWT user/session and current canonical organization access.
 * Missing RPCs/grants throw; there is no local scope cache, service-role retry or invented epoch.
 */
export function createSupabaseInboxRepository(client: InboxRpcClient): InboxWorksetRepository {
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
    async authenticate(_request, signal) { return authorize(null, signal); },
    async getAccess(session, orgId, signal) {
      const current = await authorize(orgId, signal);
      if (!same(current, session) || current.orgId !== orgId) return null;
      return { sessionActive: true, activeMembershipCount: 1, status: "active", epoch: current.epoch, expiresAt: current.expiresAt, deletionPrepared: false };
    },
    async getScope(id, signal) {
      signal.throwIfAborted();
      const { data, error } = await client.rpc("inbox_get_sync_scope", { scope_id: id }).abortSignal(signal);
      signal.throwIfAborted();
      if (error) throw inboxDatabaseError(error);
      return scope(data);
    },
    async createScope(session, request, signal) {
      // This first integration increment supports canonical views only. Reject unsupported
      // cursors explicitly; never silently turn a paged/search request into the first page.
      if (request.cursor !== null) throw new InboxHttpError(400);
      const current = await authorize(request.orgId, signal);
      if (!same(current, session) || current.orgId !== request.orgId) throw unavailable();
      const { data, error } = await client.rpc("inbox_create_workset", { org_id: request.orgId, filter: request.filter as Json, limit: request.limit, replaces_scope_id: request.replacesScopeId ?? null }).abortSignal(signal);
      signal.throwIfAborted();
      if (error) throw inboxDatabaseError(error);
      const created = scope(data);
      if (!created || !same(created, session) || created.orgId !== request.orgId) throw unavailable();
      return created;
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
