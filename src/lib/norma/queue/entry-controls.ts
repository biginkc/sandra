import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

import { looseRpc } from "../rpc";

/**
 * Testable core behind the pause / resume / cancel server actions. Any active member of the entry's org may act
 * (enforced in SQL via `p_actor`); the session client (RLS) only proves the caller can read the entry.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Client = SupabaseClient<Database>;

export type NormaQueueControlAction = "pause" | "resume" | "cancel";

export type NormaQueueControlDeps = {
  getUserId: () => Promise<string | null>;
  sessionClient: Client;
  adminClient: Client;
};

export type NormaQueueControlEntryResult =
  | { entryId: string; ok: true }
  | { entryId: string; ok: false; code: "not_found" | "refused" | "noop" | "error"; reason?: string };

export type NormaQueueControlResult =
  | { ok: true; results: NormaQueueControlEntryResult[] }
  | { ok: false; code: "unauthenticated" | "error" };

const FUNCTIONS: Record<NormaQueueControlAction, { name: string; success: string }> = {
  pause: { name: "fn_norma_queue_pause", success: "paused" },
  resume: { name: "fn_norma_queue_resume", success: "resumed" },
  cancel: { name: "fn_norma_queue_cancel", success: "cancelled" },
};

export async function controlNormaQueueEntriesCore(
  action: NormaQueueControlAction,
  entryIds: string[],
  deps: NormaQueueControlDeps,
): Promise<NormaQueueControlResult> {
  try {
    const userId = await deps.getUserId();
    if (!userId) return { ok: false, code: "unauthenticated" };

    const distinct = [...new Set(entryIds)];
    const valid = distinct.filter((id) => UUID_PATTERN.test(id));
    const readable = new Set<string>();
    if (valid.length > 0) {
      const { data, error } = await (deps.sessionClient as unknown as {
        from: (t: string) => { select: (c: string) => { in: (c: string, v: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }> } };
      })
        .from("norma_queue_entries")
        .select("id, org_id, requested_by")
        .in("id", valid);
      if (error) return { ok: false, code: "error" };
      for (const row of (data ?? []) as Array<{ id: string }>) readable.add(row.id);
    }

    const rpc = looseRpc(deps.adminClient);
    const { name, success } = FUNCTIONS[action];
    const results: NormaQueueControlEntryResult[] = [];
    for (const entryId of distinct) {
      if (!readable.has(entryId)) {
        results.push({ entryId, ok: false, code: "not_found" });
        continue;
      }
      try {
        const { data, error } = await rpc.rpc(name, { p_entry_id: entryId, p_actor: userId });
        if (error) throw new Error(`${name}: ${error.message}`);
        const answer = typeof data === "string" ? data : "";
        if (answer === success) results.push({ entryId, ok: true });
        else if (answer.startsWith("refused:")) results.push({ entryId, ok: false, code: "refused", reason: answer.slice("refused:".length) });
        else if (answer === "noop") results.push({ entryId, ok: false, code: "noop" });
        else throw new Error(`${name}: unexpected result`);
      } catch (error) {
        reportError(error, { tags: { surface: "norma_queue_control" }, extra: { action, entryId } });
        results.push({ entryId, ok: false, code: "error" });
      }
    }
    return { ok: true, results };
  } catch (error) {
    reportError(error, { tags: { surface: "norma_queue_control" } });
    return { ok: false, code: "error" };
  }
}
