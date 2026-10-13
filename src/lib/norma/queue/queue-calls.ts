import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import { looseRpc } from "../rpc";
import { readNormaQueueConfig } from "./config";

/**
 * Testable core behind the `queueNormaCalls(propertyIds, repContext)` server action. The session client (RLS) proves
 * which leads the caller may see; the service-role client calls `fn_norma_queue_enqueue`. SQL is the only authority
 * for the schedule: this never derives a zone or a next attempt.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const QUEUE_NORMA_CHUNK_SIZE = 200;
export const QUEUE_NORMA_REP_CONTEXT_MAX = 2000;

type Client = SupabaseClient<Database>;

export type QueueNormaCallsDeps = {
  getUserId: () => Promise<string | null>;
  sessionClient: Client;
  adminClient: Client;
  env?: Record<string, string | undefined>;
};

export type QueueNormaResultKind = "queued" | "already_queued" | "blocked" | "open_request" | "unknown_state" | "not_found" | "error";

export type QueueNormaLeadResult = {
  propertyId: string;
  result: QueueNormaResultKind;
  entryId: string | null;
  reason: string | null;
  /** Passed through from SQL; null when SQL returned none. */
  nextAttemptAt: string | null;
  zone: string | null;
};

export type QueueNormaCallsResult =
  | { ok: true; queueEnabled: boolean; results: QueueNormaLeadResult[] }
  | { ok: false; code: "unauthenticated" | "not_member" | "error" };

const RPC_RESULTS = new Set<string>(["queued", "already_queued", "blocked", "open_request", "unknown_state"]);

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const lead = (propertyId: string, result: QueueNormaResultKind, extra: Partial<QueueNormaLeadResult> = {}): QueueNormaLeadResult => ({
  propertyId, result, entryId: null, reason: null, nextAttemptAt: null, zone: null, ...extra,
});

export async function queueNormaCallsCore(
  propertyIds: string[],
  repContext: string | null,
  deps: QueueNormaCallsDeps,
): Promise<QueueNormaCallsResult> {
  try {
    const userId = await deps.getUserId();
    if (!userId) return { ok: false, code: "unauthenticated" };

    const config = readNormaQueueConfig(deps.env ?? process.env);
    const context = repContext?.trim() ? repContext.trim().slice(0, QUEUE_NORMA_REP_CONTEXT_MAX) : null;

    const distinct = [...new Set(propertyIds)];
    const results = new Map<string, QueueNormaLeadResult>();
    const valid: string[] = [];
    for (const id of distinct) {
      if (UUID_PATTERN.test(id)) valid.push(id);
      else results.set(id, lead(id, "not_found"));
    }

    // RLS read: leads the caller cannot see are "not found" and never reach the service-role client.
    const orgOf = new Map<string, string>();
    for (const ids of chunk(valid, QUEUE_NORMA_CHUNK_SIZE)) {
      const { data, error } = await deps.sessionClient.from("properties").select("id, org_id, state").is("deleted_at", null).in("id", ids);
      if (error) return { ok: false, code: "error" };
      for (const row of (data ?? []) as Array<{ id: string; org_id: string }>) orgOf.set(row.id, row.org_id);
    }
    for (const id of valid) if (!orgOf.has(id)) results.set(id, lead(id, "not_found"));

    const byOrg = new Map<string, string[]>();
    for (const id of valid) {
      const org = orgOf.get(id);
      if (org) byOrg.set(org, [...(byOrg.get(org) ?? []), id]);
    }
    const rpc = looseRpc(deps.adminClient);
    for (const [orgId, ids] of byOrg) {
      for (const batch of chunk(ids, QUEUE_NORMA_CHUNK_SIZE)) {
        const { data, error } = await rpc.rpc("fn_norma_queue_enqueue", {
          p_org_id: orgId,
          p_requested_by: userId,
          p_property_ids: batch,
          p_rep_context: context,
        });
        if (error) {
          if (error.message.includes("requester_not_member")) return { ok: false, code: "not_member" };
          reportError(new Error(`fn_norma_queue_enqueue: ${error.message}`), { tags: { surface: "norma_queue_enqueue" } });
          return { ok: false, code: "error" };
        }
        const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const propertyId = typeof row.property_id === "string" ? row.property_id : null;
          if (!propertyId || !batch.includes(propertyId)) continue;
          const kind = typeof row.result === "string" && RPC_RESULTS.has(row.result) ? (row.result as QueueNormaResultKind) : "error";
          results.set(propertyId, lead(propertyId, kind, {
            entryId: typeof row.entry_id === "string" ? row.entry_id : null,
            reason: typeof row.reason === "string" ? row.reason : null,
            nextAttemptAt: typeof row.next_attempt_at === "string" ? row.next_attempt_at : null,
            zone: typeof row.display_tz === "string" ? row.display_tz : null,
          }));
        }
        for (const id of batch) if (!results.has(id)) results.set(id, lead(id, "error"));
      }
    }

    return { ok: true, queueEnabled: config.enabled, results: distinct.map((id) => results.get(id) ?? lead(id, "not_found")) };
  } catch (error) {
    reportError(error, { tags: { surface: "norma_queue_calls" } });
    return { ok: false, code: "error" };
  }
}
