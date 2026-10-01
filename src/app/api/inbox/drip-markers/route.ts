import { isInboxSameOrigin } from "@/lib/inbox/same-origin";
import { createClient } from "@/lib/supabase/server";
import { createInboxDripRepository, type DripRpcClient } from "@/lib/inbox/drip-markers";
import { InboxHttpError } from "@/lib/inbox/http-error";

const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function POST(request: Request) {
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") return Response.json({ error: "Not found" }, { status: 404, headers });
  if (!isInboxSameOrigin(request)) return Response.json({ error: "Inbox markers unavailable" }, { status: 403, headers });
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new InboxHttpError(400);
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new InboxHttpError(400);
    const value = body as Record<string, unknown>;
    if (Object.keys(value).length !== 2 || typeof value.orgId !== "string" || !uuid.test(value.orgId) ||
      !Array.isArray(value.conversationIds) || value.conversationIds.length > 500 ||
      value.conversationIds.some(id => typeof id !== "string" || !uuid.test(id)) ||
      new Set(value.conversationIds).size !== value.conversationIds.length) throw new InboxHttpError(400);
    const client = await createClient();
    const data = await createInboxDripRepository(client as unknown as DripRpcClient).markers(value.orgId, value.conversationIds, AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]));
    return Response.json(data, { headers });
  } catch (error) {
    return Response.json({ error: "Inbox markers unavailable" }, { status: error instanceof InboxHttpError ? error.status : 503, headers });
  }
}
