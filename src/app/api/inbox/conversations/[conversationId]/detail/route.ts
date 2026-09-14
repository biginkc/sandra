import { createClient } from "@/lib/supabase/server";
import { createInboxReadRepository, InboxReadError, type InboxReadClient } from "@/lib/inbox/read-api";
const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
export async function GET(request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") return Response.json({ error: "Not found" }, { status: 404, headers });
  try {
    const query = new URL(request.url).searchParams;
    // Opaque server-recorded cursors bind requester, session and conversation.
    if ([...query.keys()].some(key => key !== "orgId" && key !== "before") || query.getAll("orgId").length !== 1 || query.getAll("before").length > 1) throw new InboxReadError(400);
    const before = query.get("before");
    if (before !== null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(before)) throw new InboxReadError(400);
    const { conversationId } = await params;
    const client = await createClient();
    const data = await createInboxReadRepository(client as unknown as InboxReadClient).detail(query.get("orgId")!, conversationId, AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]), query.get("before") ?? undefined);
    return Response.json(data, { headers });
  } catch (error) {
    return Response.json({ error: "Inbox detail unavailable" }, { status: error instanceof InboxReadError ? error.status : 503, headers });
  }
}
