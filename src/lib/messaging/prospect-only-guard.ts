import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

const GUARD_CHUNK = 250;

/** `audience_snapshot.source` written by resolveAdHocBulkSmsCampaign. */
export const AD_HOC_BULK_SMS_SOURCE = "bulk_sms_modal";

/** Provenance comes from the stored campaign row, never from request input. */
export function campaignSourceFromSnapshot(
  audienceSnapshot: unknown,
): "ad_hoc_bulk_sms" | "saved_campaign" {
  const source =
    audienceSnapshot &&
    typeof audienceSnapshot === "object" &&
    !Array.isArray(audienceSnapshot)
      ? (audienceSnapshot as { source?: unknown }).source
      : null;
  return source === AD_HOC_BULK_SMS_SOURCE ? "ad_hoc_bulk_sms" : "saved_campaign";
}

export type ProspectOnlyResult = {
  /** Input order preserved, de-duplicated. */
  prospectIds: string[];
  /** Distinct input ids that are not live prospects (leads, deleted, unreadable). */
  skippedLeads: number;
};

/**
 * Ad-hoc bulk SMS acts on prospects only (owner decision D1): a mass text to a
 * lead mid-conversation risks double-texting and 10DLC content mismatch.
 * Re-reads current status immediately before queueing, so a stale or forged
 * selection cannot reach leads. Saved-campaign sends do NOT use this guard
 * (they are bound to their frozen audience instead).
 */
export async function filterToProspectIds(
  client: SupabaseClient<Database>,
  propertyIds: readonly string[],
): Promise<ProspectOnlyResult> {
  const unique = [...new Set(propertyIds)];
  const live = new Set<string>();
  for (let i = 0; i < unique.length; i += GUARD_CHUNK) {
    const { data, error } = await client
      .from("properties")
      .select("id")
      .in("id", unique.slice(i, i + GUARD_CHUNK))
      .eq("status", "prospect")
      .is("deleted_at", null);
    if (error) throw new Error(`Prospect-only guard failed: ${error.message}`);
    for (const row of data ?? []) live.add(row.id);
  }
  const prospectIds = unique.filter((id) => live.has(id));
  return { prospectIds, skippedLeads: unique.length - prospectIds.length };
}
