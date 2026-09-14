import { createClient } from "@/lib/supabase/server";
import { createSupabaseInboxRepository, type InboxRpcClient } from "@/lib/inbox/supabase-sync-repository";
import { createInboxSyncGateway } from "@/lib/inbox/sync-gateway";

export async function GET(request: Request, { params }: { params: Promise<{ scopeId: string }> }) {
  const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") return Response.json({ error: "Not found" }, { status: 404, headers });
  try {
    const electricUrl = process.env.INBOX_ELECTRIC_SHAPE_URL;
    const projectionTable = process.env.INBOX_ELECTRIC_PROJECTION_TABLE;
    if (!electricUrl || !projectionTable) throw Error("Missing Inbox configuration");
    const client = await createClient();
    const { scopeId } = await params;
    return await createInboxSyncGateway({ repository: createSupabaseInboxRepository(client as unknown as InboxRpcClient), electricUrl, projectionTable })(request, scopeId);
  } catch { return Response.json({ error: "Inbox synchronization unavailable" }, { status: 503, headers }); }
}
