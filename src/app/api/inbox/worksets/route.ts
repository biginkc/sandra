import { isInboxSameOrigin } from "@/lib/inbox/same-origin";
import { createClient } from "@/lib/supabase/server";
import { createSupabaseInboxRepository, type InboxRpcClient } from "@/lib/inbox/supabase-sync-repository";
import { createInboxWorksetHandler } from "@/lib/inbox/workset-handler";
import { isInboxPilotRequest, type InboxPilotAuthClient } from "@/lib/inbox/pilot-cohort";

export async function POST(request: Request) {
  const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") return Response.json({ error: "Not found" }, { status: 404, headers });
  // A cookie-authenticated mutation must not permit cross-origin scope churn.
  if (!isInboxSameOrigin(request)) return Response.json({ error: "Inbox workset unavailable" }, { status: 403, headers });
  try {
    const client = await createClient();
    // GL-4/G5: pilot cohort gate before the inbox_* RPC below.
    if (!(await isInboxPilotRequest(client as unknown as InboxPilotAuthClient))) return Response.json({ error: "Not found" }, { status: 404, headers });
    // Narrow RPC extension remains explicit until deployed schema types are regenerated.
    return await createInboxWorksetHandler(createSupabaseInboxRepository(client as unknown as InboxRpcClient))(request);
  } catch { return Response.json({ error: "Inbox workset unavailable" }, { status: 503, headers }); }
}
