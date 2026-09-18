import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import { parseInboxFilter, type InboxFilter } from "./filter-contract";
import { InboxHttpError, inboxDatabaseError } from "./http-error";
import { createSupabaseInboxRepository, type InboxRpcClient } from "./supabase-sync-repository";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export type SelectionReviewTarget = { kind: "conversation" | "unknown_sender_group"; id: string };
export type SelectionReviewInput = { orgId: string; filter: InboxFilter; targets: SelectionReviewTarget[]; generation: string };
export type SelectionReviewItem = SelectionReviewTarget & { status: "matching" | "outside_filter" | "unavailable"; name: string | null };
export type SelectionReviewResult = { orgId: string; requesterId: string; sessionId: string; accessEpoch: string; generation: string; items: SelectionReviewItem[] };
type ReviewDatabase = Omit<Database, "public"> & { public: Omit<Database["public"], "Functions"> & { Functions: Database["public"]["Functions"] & {
  inbox_review_selection: { Args: { org_id: string; filter: Json; targets: Json }; Returns: Json };
} } };
export type SelectionReviewClient = Pick<SupabaseClient<ReviewDatabase>, "rpc">;
function object(value: unknown, status: 400 | 503): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InboxHttpError(status);
  return value as Record<string, unknown>;
}
export function parseSelectionReview(value: unknown): SelectionReviewInput {
  const row = object(value, 400);
  if (Object.keys(row).length !== 4 || Object.keys(row).some(key => !["orgId", "filter", "targets", "generation"].includes(key)) ||
    typeof row.orgId !== "string" || !UUID.test(row.orgId) || typeof row.generation !== "string" || !UUID.test(row.generation)) throw new InboxHttpError(400);
  const filter = parseInboxFilter(row.filter);
  if (!filter || (filter.search?.length ?? 0) > 100 || !Array.isArray(row.targets) || row.targets.length < 1 || row.targets.length > 100) throw new InboxHttpError(400);
  const seen = new Set<string>();
  const targets = row.targets.map(value => {
    const target = object(value, 400);
    if (Object.keys(target).length !== 2 || !["conversation", "unknown_sender_group"].includes(String(target.kind)) || typeof target.id !== "string" || !UUID.test(target.id)) throw new InboxHttpError(400);
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) throw new InboxHttpError(400);
    seen.add(key);
    return { kind: target.kind as SelectionReviewTarget["kind"], id: target.id };
  });
  return { orgId: row.orgId, filter, targets, generation: row.generation };
}
/** One batch uses the same filter as the workset and returns every requested ID,
 * including unavailable IDs without disclosing an entity name. */
export function createSelectionReviewRepository(client: SelectionReviewClient) {
  const authority = createSupabaseInboxRepository(client as unknown as InboxRpcClient);
  return async (input: SelectionReviewInput, signal: AbortSignal): Promise<SelectionReviewResult> => {
    const before = await authority.getContext(signal);
    if (before.orgId !== input.orgId || before.expiresAt <= Date.now()) throw new InboxHttpError(403);
    const { data, error } = await client.rpc("inbox_review_selection", { org_id: input.orgId, filter: input.filter as Json, targets: input.targets as Json }).abortSignal(signal);
    signal.throwIfAborted();
    if (error) throw inboxDatabaseError(error);
    const row = object(data, 503);
    if (row.org_id !== input.orgId || row.requester_id !== before.userId || row.session_id !== before.sessionId || row.access_epoch !== before.accessEpoch || !Array.isArray(row.items) || row.items.length !== input.targets.length) throw new InboxHttpError(503);
    const items = row.items.map((value, index): SelectionReviewItem => {
      const item = object(value, 503), expected = input.targets[index];
      if (item.kind !== expected.kind || item.id !== expected.id || !["matching", "outside_filter", "unavailable"].includes(String(item.status)) ||
        !(item.name === null || (typeof item.name === "string" && item.name.length <= 2000)) || (item.status === "unavailable" && item.name !== null)) throw new InboxHttpError(503);
      return { ...expected, status: item.status as SelectionReviewItem["status"], name: item.name as string | null };
    });
    const after = await authority.getContext(signal);
    if (after.orgId !== before.orgId || after.userId !== before.userId || after.sessionId !== before.sessionId || after.accessEpoch !== before.accessEpoch || after.expiresAt <= Date.now()) throw new InboxHttpError(403);
    return { orgId: before.orgId, requesterId: before.userId, sessionId: before.sessionId, accessEpoch: before.accessEpoch, generation: input.generation, items };
  };
}
