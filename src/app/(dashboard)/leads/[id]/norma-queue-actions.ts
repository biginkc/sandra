"use server";

import { revalidatePath } from "next/cache";

import { reportError } from "@/lib/errors/report";
import { controlNormaQueueEntriesCore, type NormaQueueControlAction } from "@/lib/norma/queue/entry-controls";
import { queueNormaCallsCore } from "@/lib/norma/queue/queue-calls";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type NormaQueueActionResult = { ok: true } | { ok: false; code: string; reason?: string };

async function userDeps() {
  const sessionClient = await createClient();
  return {
    getUserId: async () => {
      const {
        data: { user },
        error,
      } = await sessionClient.auth.getUser();
      return error || !user ? null : user.id;
    },
    sessionClient,
    adminClient: createAdminClient(),
  };
}

/** "Add to Norma queue" from the lead page: the same enqueue path as the bulk dialog, for one lead. */
export async function addToNormaQueue(propertyId: string, repContext: string | null): Promise<NormaQueueActionResult> {
  try {
    const result = await queueNormaCallsCore([propertyId], repContext, await userDeps());
    if (!result.ok) return { ok: false, code: result.code };
    const row = result.results[0];
    if (row && (row.result === "queued" || row.result === "already_queued")) {
      revalidatePath(`/leads/${propertyId}`);
      return { ok: true };
    }
    return { ok: false, code: row?.result ?? "error", ...(row?.reason ? { reason: row.reason } : {}) };
  } catch (error) {
    reportError(error, { tags: { surface: "norma_queue_add" }, extra: { propertyId } });
    return { ok: false, code: "error" };
  }
}

async function control(action: NormaQueueControlAction, entryId: string): Promise<NormaQueueActionResult> {
  try {
    const result = await controlNormaQueueEntriesCore(action, [entryId], await userDeps());
    if (!result.ok) return { ok: false, code: result.code };
    const row = result.results[0];
    revalidatePath("/norma/queue");
    if (row?.ok) return { ok: true };
    return { ok: false, code: row?.code ?? "error", ...(row && !row.ok && row.reason ? { reason: row.reason } : {}) };
  } catch (error) {
    reportError(error, { tags: { surface: "norma_queue_control" }, extra: { action, entryId } });
    return { ok: false, code: "error" };
  }
}

export async function pauseNormaQueueEntry(entryId: string) {
  return control("pause", entryId);
}
export async function resumeNormaQueueEntry(entryId: string) {
  return control("resume", entryId);
}
export async function cancelNormaQueueEntry(entryId: string) {
  return control("cancel", entryId);
}
