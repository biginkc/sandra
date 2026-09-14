import { createClient } from "@/lib/supabase/server";
import { createSupabaseInboxRepository, type InboxRpcClient } from "@/lib/inbox/supabase-sync-repository";
import { createInboxSyncGateway } from "@/lib/inbox/sync-gateway";
import { inboxSyncUpstream } from "@/lib/inbox/sync-upstream-config";
import { isInboxPilotRequest, type InboxPilotAuthClient } from "@/lib/inbox/pilot-cohort";

export async function GET(request: Request, { params }: { params: Promise<{ scopeId: string }> }) {
  const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") return Response.json({ error: "Not found" }, { status: 404, headers });
  try {
    const upstream = inboxSyncUpstream(process.env);
    const client = await createClient();
    // GL-4/G5: pilot cohort gate before the inbox_* RPC below.
    if (!(await isInboxPilotRequest(client as unknown as InboxPilotAuthClient))) return Response.json({ error: "Not found" }, { status: 404, headers });
    const { scopeId } = await params;
    return await createInboxSyncGateway({ repository: createSupabaseInboxRepository(client as unknown as InboxRpcClient), ...upstream })(request, scopeId);
  } catch { return Response.json({ error: "Inbox synchronization unavailable" }, { status: 503, headers }); }
}
