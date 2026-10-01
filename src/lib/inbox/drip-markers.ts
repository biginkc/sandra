import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import { InboxHttpError, inboxDatabaseError } from "./http-error";

type DripDatabase = Omit<Database, "public"> & { public: Omit<Database["public"], "Functions"> & { Functions: Database["public"]["Functions"] & {
  inbox_drip_markers_v1: { Args: { org_id: string; conversation_ids: string[] }; Returns: Json };
  inbox_drip_counts_v1: { Args: { org_id: string; filter: Json }; Returns: Json };
} } };
export type DripRpcClient = Pick<SupabaseClient<DripDatabase>, "rpc">;

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InboxHttpError(503);
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new InboxHttpError(503);
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new InboxHttpError(503);
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new InboxHttpError(503);
  return value;
}
function nullableUuid(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !uuid.test(value)) throw new InboxHttpError(503);
  return value;
}

export type InboxDripMarker = {
  conversationId: string;
  propertyId: string | null;
  inDrip: boolean;
  dripReplied: boolean;
  dripName: string | null;
};
export type InboxDripMarkers = { orgId: string; asOf: string; rows: InboxDripMarker[] };
export type InboxDripCounts = { inDrip: number; dripReplied: number; asOf: string; accessEpoch: string };

function parseMarkers(value: unknown, orgId: string): InboxDripMarkers {
  const row = object(value);
  if (row.org_id !== orgId || !Array.isArray(row.rows) || row.rows.length > 500) throw new InboxHttpError(503);
  const seen = new Set<string>();
  const rows = row.rows.map(value => {
    const item = object(value);
    const conversationId = text(item.conversation_id);
    if (!uuid.test(conversationId) || seen.has(conversationId)) throw new InboxHttpError(503);
    seen.add(conversationId);
    const dripName = item.drip_name === null ? null : text(item.drip_name);
    if (dripName !== null && dripName.length > 2000) throw new InboxHttpError(503);
    return {
      conversationId,
      propertyId: nullableUuid(item.property_id),
      inDrip: boolean(item.in_drip),
      dripReplied: boolean(item.drip_replied),
      dripName,
    };
  });
  return { orgId, asOf: timestamp(row.as_of), rows };
}

function parseCounts(value: unknown, orgId: string): InboxDripCounts {
  const row = object(value), counts = object(row.counts);
  const inDrip = counts.in_drip, dripReplied = counts.drip_replied;
  if (row.org_id !== orgId || !Number.isSafeInteger(inDrip) || (inDrip as number) < 0 ||
    !Number.isSafeInteger(dripReplied) || (dripReplied as number) < 0) throw new InboxHttpError(503);
  return { inDrip: inDrip as number, dripReplied: dripReplied as number, asOf: timestamp(row.as_of), accessEpoch: text(row.access_epoch) };
}

export function createInboxDripRepository(client: DripRpcClient) {
  return {
    async markers(orgId: string, conversationIds: readonly string[], signal: AbortSignal): Promise<InboxDripMarkers> {
      if (!uuid.test(orgId) || conversationIds.length > 500 || conversationIds.some(id => !uuid.test(id)) || new Set(conversationIds).size !== conversationIds.length) throw new InboxHttpError(400);
      signal.throwIfAborted();
      const { data, error } = await client.rpc("inbox_drip_markers_v1", { org_id: orgId, conversation_ids: [...conversationIds] }).abortSignal(signal);
      signal.throwIfAborted();
      if (error) throw inboxDatabaseError(error);
      return parseMarkers(data, orgId);
    },
    async counts(orgId: string, filter: Record<string, unknown>, signal: AbortSignal): Promise<InboxDripCounts> {
      if (!uuid.test(orgId)) throw new InboxHttpError(400);
      signal.throwIfAborted();
      const { data, error } = await client.rpc("inbox_drip_counts_v1", { org_id: orgId, filter: filter as Json }).abortSignal(signal);
      signal.throwIfAborted();
      if (error) throw inboxDatabaseError(error);
      return parseCounts(data, orgId);
    },
  };
}
