import { createClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/errors/report";
import { err } from "@/lib/errors/result";

const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json(err({ code: "UNAUTHORIZED", message: "Authentication required" }), { status: 401, headers });
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 100);
  if (q.length < 3) return Response.json({ results: [] }, { headers });
  const { data, error } = await supabase.rpc("search_global", { q, per_type: 5 });
  if (error) {
    reportError(error, { tags: { surface: "global_search" } });
    if (error.code === "PGRST202") return Response.json({ results: [], degraded: true }, { headers });
    return Response.json(err({ code: "SEARCH_FAILED", message: "Search unavailable" }), { status: 500, headers });
  }
  const results = (data ?? []).map(row => ({
    type: row.entity_type,
    key: `${row.entity_type}-${row.entity_type === "thread" ? row.conversation_id : row.entity_id}`,
    title: row.title,
    subtitle: row.subtitle,
    matchedField: row.matched_field,
    href: row.entity_type === "property" ? `/leads/${row.entity_id}`
      : row.entity_type === "owner" && row.property_id ? `/leads/${row.property_id}`
        : `/messages?thread=${row.conversation_id}`,
  }));
  return Response.json({ results }, { headers });
}
