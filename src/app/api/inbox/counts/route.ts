import { createClient } from "@/lib/supabase/server";
import { createSupabaseInboxRepository, type InboxRpcClient } from "@/lib/inbox/supabase-sync-repository";
import { createInboxCountsHandler } from "@/lib/inbox/counts-handler";
import { createInboxDripCountsHandler } from "@/lib/inbox/drip-counts-handler";
import { createInboxDripRepository, type DripRpcClient } from "@/lib/inbox/drip-markers";
export async function GET(request: Request) {
  const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") return Response.json({ error: "Not found" }, { status: 404, headers });
  try {
    const client = await createClient();
    const view = new URL(request.url).searchParams.get("view");
    if (view === "in_drip" || view === "drip_replied") {
      return await createInboxDripCountsHandler(createInboxDripRepository(client as unknown as DripRpcClient))(request);
    }
    return await createInboxCountsHandler(createSupabaseInboxRepository(client as unknown as InboxRpcClient))(request);
  } catch { return Response.json({ error: "Inbox counts unavailable" }, { status: 503, headers }); }
}
