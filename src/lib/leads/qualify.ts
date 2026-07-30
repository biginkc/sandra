import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

export type QualifyOutcome =
  | { status: "qualified" }
  | { status: "already_qualified" }
  | { status: "not_found" }
  | { status: "failed"; message: string };

/**
 * Promote a prospect to `new_lead`. Idempotent: if the property is already
 * past `prospect` the call is a no-op. Uses a double-guard write so that
 * concurrent manual promotions don't clobber the first `qualified_at`
 * timestamp.
 *
 * The caller supplies the supabase client so this works from both a
 * server-action (cookie-based user client) and trusted server-side
 * maintenance paths.
 */
export async function qualifyProperty(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  qualifiedBy: string | null,
): Promise<QualifyOutcome> {
  const { data: current, error: lookupErr } = await supabase
    .from("properties")
    .select("status")
    .eq("id", propertyId)
    .maybeSingle();
  if (lookupErr) return { status: "failed", message: lookupErr.message };
  if (!current) return { status: "not_found" };
  if (current.status !== "prospect") return { status: "already_qualified" };

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("properties")
    .update({
      status: "new_lead",
      qualified_at: nowIso,
      qualified_by: qualifiedBy,
      updated_at: nowIso,
    })
    .eq("id", propertyId)
    .eq("status", "prospect");

  if (error) return { status: "failed", message: error.message };
  return { status: "qualified" };
}
