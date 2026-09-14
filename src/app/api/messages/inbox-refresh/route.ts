import { createClient } from "@/lib/supabase/server";
import { listThreadPage, type ThreadPageFilter } from "@/lib/messages/list-threads";
import { listUnknownSenders } from "@/lib/messages/list-unknown-senders";
import { parseInboxFilter, normalizeInboxFilterForUser, isThreadFilter } from "@/app/(dashboard)/messages/inbox-filter-resolve";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** Preserve the existing inbox/count algorithms without rebuilding the page,
 * selected composer, roster or lead controls after a message event. */
export async function GET(request: Request) {
  try {
    const client = await createClient();
    const { data: { user } } = await client.auth.getUser();
    if (!user) return Response.json({ error: "Sign in to read messages." }, { status: 401, headers });
    const params = new URL(request.url).searchParams;
    const filter = normalizeInboxFilterForUser(parseInboxFilter(params.get("filter") ?? undefined), user.id);
    if (!isThreadFilter(filter)) return Response.json({ error: "Invalid inbox filter." }, { status: 400, headers });
    const thread = params.get("thread");
    if (thread && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(thread)) return Response.json({ error: "Invalid conversation." }, { status: 400, headers });
    const requestedPage = Number(params.get("inboxPage") ?? 1);
    const [page, unknown] = await Promise.all([
      listThreadPage(client, {
        filter: filter as ThreadPageFilter, currentUserId: user.id, includeThreadId: thread,
        page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
        hideNoise: params.get("hideDnc") !== "0", search: (params.get("search") ?? "").trim().slice(0, 100),
      }),
      listUnknownSenders(client, { includeDismissed: true }),
    ]);
    return Response.json({ page, unknown: unknown.filter(sender => !sender.isDismissed).length,
      dismissed: unknown.filter(sender => sender.isDismissed).length }, { headers });
  } catch {
    return Response.json({ error: "Inbox updates did not load. Please retry." }, { status: 503, headers });
  }
}
