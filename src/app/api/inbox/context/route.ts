import { createClient } from "@/lib/supabase/server";
import { createSupabaseInboxRepository, type InboxRpcClient } from "@/lib/inbox/supabase-sync-repository";
import { InboxHttpError } from "@/lib/inbox/http-error";
const headers = { "cache-control": "no-store, private" };
export async function GET(request: Request) {
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") return new Response(null, { status: 404, headers });
  if (new URL(request.url).search) return new Response(null, { status: 400, headers });
  try {
    const client = await createClient();
    const context = await createSupabaseInboxRepository(client as unknown as InboxRpcClient).getContext(AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]));
    return Response.json(context, { headers });
  } catch (error) {
    return Response.json({ error: "Inbox access could not be verified" }, { status: error instanceof InboxHttpError ? error.status : 503, headers });
  }
}
