import type { LooseSupabase } from "./queries";

/**
 * Newest replay batch id for a replay org, or null. replay_batches is not in
 * the generated types; any error, missing table or empty result fails quiet.
 */
export async function loadReplayBatchId(
  supabase: LooseSupabase,
  orgId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("replay_batches")
      .select("id")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data || typeof data.id !== "string") return null;
    return data.id;
  } catch {
    return null;
  }
}
