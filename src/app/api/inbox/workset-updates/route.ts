import { createClient } from "@/lib/supabase/server";
import { isInboxSameOrigin } from "@/lib/inbox/same-origin";
import { createSupabaseInboxRepository, type InboxRpcClient } from "@/lib/inbox/supabase-sync-repository";
import { InboxHttpError } from "@/lib/inbox/http-error";
import { isInboxPilotRequest, type InboxPilotAuthClient } from "@/lib/inbox/pilot-cohort";
import { probeInboxWorksetUpdates, type InboxWorksetUpdateRpcClient } from "@/lib/inbox/workset-updates";
import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { canAccessMessagesAndLeadsBoard } from "@/lib/auth/surface-access";

const headers = { "cache-control": "private, no-store", vary: "Cookie, Authorization" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  if (process.env.INBOX_WORKSPACE_SERVER_ENABLED !== "1") return Response.json({ error: "Not found" }, { status: 404, headers });
  if (!isInboxSameOrigin(request)) return Response.json({ error: "Inbox workset unavailable" }, { status: 403, headers });
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].length !== 1 || !url.searchParams.has("scopeId")) throw new InboxHttpError(400);
    const scopeId = url.searchParams.get("scopeId");
    if (!scopeId || !UUID.test(scopeId)) throw new InboxHttpError(400);
    const client = await createClient();
    if (!canAccessMessagesAndLeadsBoard(await getCallerMembershipsOrThrow())) return Response.json({ error: "Not found" }, { status: 404, headers });
    // Keep the same pilot/session admission boundary as the existing workset
    // route before invoking the authenticated, scope-bound RPC.
    if (!(await isInboxPilotRequest(client as unknown as InboxPilotAuthClient))) return Response.json({ error: "Not found" }, { status: 404, headers });
    const value = await probeInboxWorksetUpdates(
      client as unknown as InboxWorksetUpdateRpcClient,
      scopeId,
      AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    );
    return Response.json(value, { headers });
  } catch (error) {
    return Response.json(
      { error: "Inbox workset unavailable" },
      { status: error instanceof InboxHttpError ? error.status : 503, headers },
    );
  }
}
