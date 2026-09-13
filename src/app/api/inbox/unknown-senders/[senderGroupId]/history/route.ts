import { createClient } from "@/lib/supabase/server";
import { createInboxReadRepository, InboxReadError, type InboxReadClient } from "@/lib/inbox/read-api";
const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
export async function GET(request: Request, { params }: { params: Promise<{ senderGroupId: string }> }) {
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") return Response.json({ error: "Not found" }, { status: 404, headers });
  try {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => key !== "orgId" && key !== "before") || query.getAll("orgId").length !== 1 || query.getAll("before").length > 1) throw new InboxReadError(400);
    const { senderGroupId } = await params;
    const client = await createClient();
    const data = await createInboxReadRepository(client as unknown as InboxReadClient).unknownHistory(query.get("orgId")!, senderGroupId,
      AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]), query.get("before") ?? undefined);
    return Response.json(data, { headers });
  } catch (error) {
    return Response.json({ error: "Inbox history unavailable" }, { status: error instanceof InboxReadError ? error.status : 503, headers });
  }
}
