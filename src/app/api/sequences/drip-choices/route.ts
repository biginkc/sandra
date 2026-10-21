import { timeServerAction } from "@/lib/perf/server-action-log";
import { loadDripChoices } from "@/lib/sequences/drip-choices";
import { createClient } from "@/lib/supabase/server";

// Per-user RLS data: never stored by a shared cache or CDN, and varied on the session cookie.
const headers = { "cache-control": "private, no-store", vary: "Cookie" };

/** Same rows as the listDripChoices server action, read over GET so it does not queue behind other server actions. */
export async function GET() {
  const result = await timeServerAction("GET drip-choices", async () => loadDripChoices(await createClient()), "/api/sequences/drip-choices");
  const status = result.ok ? 200 : result.error.code === "UNAUTHENTICATED" ? 401 : 500;
  return Response.json(result, { status, headers });
}
