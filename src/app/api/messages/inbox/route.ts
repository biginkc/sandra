import { createClient } from "@/lib/supabase/server";
import { listThreadPage, type ThreadPageFilter } from "@/lib/messages/list-threads";
import { isThreadFilter, parseInboxFilter, normalizeInboxFilterForUser } from "@/app/(dashboard)/messages/inbox-filter-resolve";
import { withPerformanceSpan } from "@/lib/performance/server-timing";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Refresh one authorized inbox page and its exact counts in the existing
 * snapshot RPC. Never hydrate detail, roster, unknown bodies or queue here. */
export function GET(request: Request) {
  return withPerformanceSpan("messages.inbox.api", async () => {
    const started = performance.now();
    try {
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return Response.json({ error: "Sign in to read messages." }, { status: 401, headers });
      const params = new URL(request.url).searchParams;
      const filter = normalizeInboxFilterForUser(parseInboxFilter(params.get("filter") ?? undefined), user.id);
      if (!isThreadFilter(filter)) return Response.json({ error: "Invalid inbox filter." }, { status: 400, headers });
      const thread = params.get("thread");
      if (thread && !uuid.test(thread)) return Response.json({ error: "Invalid conversation." }, { status: 400, headers });
      const rawPage = Number(params.get("inboxPage") ?? 1);
      const page = await listThreadPage(supabase, {
        filter: filter as ThreadPageFilter, currentUserId: user.id, includeThreadId: thread,
        search: (params.get("search") ?? "").trim().slice(0, 100),
        hideNoise: params.get("hideDnc") !== "0",
        page: Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1,
      });
      return Response.json({ page }, { headers: { ...headers, "Server-Timing": `inbox;dur=${(performance.now() - started).toFixed(1)}` } });
    } catch {
      return Response.json({ error: "Inbox updates did not load. Please retry." }, { status: 503, headers });
    }
  });
}
