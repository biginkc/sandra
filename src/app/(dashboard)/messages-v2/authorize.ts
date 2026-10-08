import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { err, ok, type Result } from "@/lib/errors/result";
import { createClient } from "@/lib/supabase/server";

import { messagesV2OrgId } from "./access";

/**
 * Shared server-side caller + org resolution for the Messages v2 server actions
 * (owner || acquisitions, the same gate as the page). Deliberately NOT in a
 * "use server" file: it must never be callable from the client. Nothing about
 * who or where comes from the client.
 */
export async function authorizeMessagesV2(): Promise<Result<{ orgId: string; userId: string }>> {
  let userId: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    userId = null;
  }
  if (!userId) {
    return err({ code: "UNAUTHENTICATED", message: "Not signed in" });
  }
  let orgId: string | null = null;
  try {
    // Only this user's own memberships count.
    const memberships = (await getCallerMembershipsOrThrow()).filter((m) => m.user_id === userId);
    orgId = messagesV2OrgId(memberships);
  } catch {
    orgId = null;
  }
  if (!orgId) {
    return err({ code: "UNAUTHORIZED", message: "You do not have access to Messages v2." });
  }
  return ok({ orgId, userId });
}
