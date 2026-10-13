"use server";

import { revalidatePath } from "next/cache";

import { queueNormaCallsCore } from "@/lib/norma/queue/queue-calls";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Bulk "Queue Norma calls". Session-authenticated; the core proves the caller can see each lead (RLS) and SQL owns every
 * rule and the schedule. Shared by the Leads board, the lead page and the Messages thread. Lives outside leads/actions.ts
 * because that file is a frozen legacy file (see src/lib/prospects/legacy-isolation.test.ts).
 */
export async function queueNormaCalls(propertyIds: string[], repContext: string | null) {
  const sessionClient = await createClient();
  const result = await queueNormaCallsCore(propertyIds, repContext, {
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
