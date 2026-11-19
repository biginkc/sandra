"use server";

import { revalidatePath } from "next/cache";

import { markNormaReviewedCore, type MarkNormaReviewedResult } from "@/lib/norma/mark-reviewed";
import { controlNormaQueueEntriesCore, type NormaQueueControlAction } from "@/lib/norma/queue/entry-controls";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

async function control(action: NormaQueueControlAction, entryIds: string[]) {
  const sessionClient = await createClient();
  const result = await controlNormaQueueEntriesCore(action, entryIds, {
    getUserId: async () => {
      const {
        data: { user },
        error,
      } = await sessionClient.auth.getUser();
      return error || !user ? null : user.id;
    },
    sessionClient,
    adminClient: createAdminClient(),
  });
  if (result.ok) revalidatePath("/norma/queue");
  return result;
}

/** Bulk resume: the single-row resume per entry, each authorised and answered independently in SQL. */
export async function resumeNormaQueueEntries(entryIds: string[]) {
  return control("resume", entryIds);
}

export async function cancelNormaQueueEntries(entryIds: string[]) {
  return control("cancel", entryIds);
}

/**
 * "Mark reviewed" for one Norma call that needs review, from the queue's review section (opened by id from My Leads).
 * The same core as the lead page: the user comes from the session; membership and every state rule are enforced in SQL.
 */
export async function markNormaRequestReviewed(propertyId: string, requestId: string): Promise<MarkNormaReviewedResult> {
  try {
    const sessionClient = await createClient();
    const result = await markNormaReviewedCore(propertyId, requestId, {
      getUserId: async () => {
        const {
          data: { user },
          error,
        } = await sessionClient.auth.getUser();
        return error || !user ? null : user.id;
      },
      adminClient: createAdminClient(),
    });
    if (result.ok || result.code === "not_waiting") revalidatePath("/norma/queue");
    return result;
  } catch {
    return { ok: false, code: "error" };
  }
}
