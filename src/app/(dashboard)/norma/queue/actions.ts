"use server";

import { revalidatePath } from "next/cache";

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
