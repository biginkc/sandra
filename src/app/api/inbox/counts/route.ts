import { createClient } from "@/lib/supabase/server";
import { createSupabaseInboxRepository, type InboxRpcClient } from "@/lib/inbox/supabase-sync-repository";
import { createInboxCountsHandler } from "@/lib/inbox/counts-handler";
export async function GET(request: Request) {
  const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") return Response.json({ error: "Not found" }, { status: 404, headers });
  try {
    const client = await createClient();
    return await createInboxCountsHandler(createSupabaseInboxRepository(client as unknown as InboxRpcClient))(request);
  } catch { return Response.json({ error: "Inbox counts unavailable" }, { status: 503, headers }); }
}
