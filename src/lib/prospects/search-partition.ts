import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

const CHUNK = 250;

export type SearchPartition = {
  /** Live prospects that are not DNC-locked: the ONLY rows any Search action may act on. */
  prospectIds: string[];
  /** Selected rows that are not live prospects (leads, deleted, unreadable). Counted BEFORE the DNC split. */
  skippedLeads: number;
  /** Live, DNC-locked prospects (never acted on, reported). */
  dncLockedIds: string[];
};

/**
 * Re-read current state for explicit ids and split them for Search actions. Runs under the
 * caller's client (RLS), so another org's ids simply do not exist for the caller and count as
 * skipped. Leads are counted before the DNC split: a locked lead is a skipped lead.
 */
export async function partitionSearchIds(
  supabase: SupabaseClient<Database>,
  propertyIds: readonly string[],
): Promise<SearchPartition> {
  const unique = [...new Set(propertyIds)];
  const byId = new Map<string, { status: string; is_dnc_locked: boolean }>();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const { data, error } = await supabase
      .from("properties")
      .select("id, status, is_dnc_locked")
      .in("id", unique.slice(i, i + CHUNK))
      .is("deleted_at", null);
    if (error) throw new Error(`Search selection check failed: ${error.message}`);
    for (const row of data ?? []) byId.set(row.id, { status: row.status, is_dnc_locked: row.is_dnc_locked });
  }
  const prospectIds: string[] = [];
  const dncLockedIds: string[] = [];
  let skippedLeads = 0;
  for (const id of unique) {
    const row = byId.get(id);
    if (!row || row.status !== "prospect") skippedLeads += 1;
    else if (row.is_dnc_locked) dncLockedIds.push(id);
    else prospectIds.push(id);
  }
  return { prospectIds, skippedLeads, dncLockedIds };
}
