/**
 * Pre-send audience assessment for bulk SMS — classifies a property
 * selection by the homeowner contact's phone_1 line type so the operator
 * sees "X mobile / Y landline / Z unknown" BEFORE anything queues.
 *
 * Landlines are always excluded from bulk sends; unknowns are excluded
 * by default with an opt-in toggle. This function only counts — the
 * actual exclusion happens in queueSmsBatch / sendSmsToContact.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

export type AudienceLineTypeAssessment = {
  /** Properties in the selection. */
  total: number;
  /** Confirmed-mobile phone_1 — will be queued. */
  mobile: number;
  /** Confirmed-landline phone_1 — always excluded. */
  landline: number;
  /** Never-classified phone_1 — excluded unless the operator opts in. */
  unknown: number;
  /** No homeowner contact or no phone_1 — nothing to text. */
  noPhone: number;
};

export async function assessAudienceLineTypes(
  client: SupabaseClient<Database>,
  propertyIds: string[],
): Promise<AudienceLineTypeAssessment> {
  const assessment: AudienceLineTypeAssessment = {
    total: propertyIds.length,
    mobile: 0,
    landline: 0,
    unknown: 0,
    noPhone: 0,
  };

  // Same 250-id chunking as queueSmsBatch — PostgREST IN-clause limit.
  const CHUNK = 250;
  const seen = new Set<string>();
  for (let i = 0; i < propertyIds.length; i += CHUNK) {
    const chunk = propertyIds.slice(i, i + CHUNK);
    const { data, error } = await client
      .from("properties")
      .select(
        `id,
         homeowner:contacts!properties_homeowner_contact_id_fkey(phone_1, phone_1_type)`,
      )
      .in("id", chunk);
    if (error) {
      throw new Error(`audience assessment fetch: ${error.message}`);
    }
    for (const row of data ?? []) {
      seen.add(row.id);
      const homeowner = row.homeowner as unknown as {
        phone_1: string | null;
        phone_1_type: string;
      } | null;
      if (!homeowner?.phone_1) {
        assessment.noPhone++;
      } else if (homeowner.phone_1_type === "mobile") {
        assessment.mobile++;
      } else if (homeowner.phone_1_type === "landline") {
        assessment.landline++;
      } else {
        assessment.unknown++;
      }
    }
  }

  // IDs that didn't come back (deleted / not visible under RLS) can't
  // be texted either.
  assessment.noPhone += propertyIds.filter((id) => !seen.has(id)).length;

  return assessment;
}
