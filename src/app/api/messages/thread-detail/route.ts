import { createClient } from "@/lib/supabase/server";
import { fetchInboxDetail } from "@/app/(dashboard)/messages/inbox-detail-data";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** A conversation click must not rebuild the inbox and every badge. */
export async function GET(request: Request) {
  const threadId = new URL(request.url).searchParams.get("thread");
  if (!threadId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId)) {
    return Response.json({ error: "Invalid conversation." }, { status: 400, headers });
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Sign in to read messages." }, { status: 401, headers });
  try {
    // Uses the caller's session and the same org isolation and fail-closed
    // consent/suppression reads as the full server-rendered Messages page.
    const detail = await fetchInboxDetail(supabase, threadId);
    return Response.json({ detail }, { headers });
  } catch {
    return Response.json({ error: "Conversation did not load. Please retry." }, { status: 503, headers });
  }
}
