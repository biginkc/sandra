import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

export type ProspectEligibilityPurpose =
  | "selection"
  | "cass"
  | "dialer"
  | "skip_trace";

export type ProspectEligibilityExclusion = {
  propertyId: string;
  reason: "dnc" | "skip_trace_disabled" | "not_found_or_not_prospect";
};

export type ProspectEligibilityResult = {
  eligibleIds: string[];
  exclusions: ProspectEligibilityExclusion[];
  dncLockedCount: number;
  skipTraceDisabledCount: number;
  /**
   * Search page counts: rows whose status is not 'prospect' (leads etc., found
   * or not found), counted BEFORE the DNC split so a locked lead is reported
   * as a skipped lead and never as a DNC prospect.
   */
  skippedLeadCount: number;
  /** DNC-locked rows that are still prospects (the DNC split after leads). */
  prospectDncLockedCount: number;
  prospectDncLockedIds: string[];
};

type EligibilityRow = {
  id: string;
  status: string;
  is_dnc_locked: boolean;
  skip_trace_disabled: boolean;
};

const LOOKUP_CHUNK = 500;

/**
 * One server-owned compliance resolver for every action launched from
 * Prospects. It re-reads current state immediately before any cost or write,
 * so stale checkboxes and forged Server Action payloads cannot bypass DNC.
 */
export async function resolveProspectEligibility(
  supabase: SupabaseClient<Database>,
  propertyIds: readonly string[],
  purpose: ProspectEligibilityPurpose,
): Promise<ProspectEligibilityResult> {
  const uniqueIds = [...new Set(propertyIds)];
  if (uniqueIds.length === 0) {
    return {
      eligibleIds: [],
      exclusions: [],
      dncLockedCount: 0,
      skipTraceDisabledCount: 0,
      skippedLeadCount: 0,
      prospectDncLockedCount: 0,
      prospectDncLockedIds: [],
    };
  }

  const rows: EligibilityRow[] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from("properties")
      .select("id, status, is_dnc_locked, skip_trace_disabled")
      .in("id", uniqueIds.slice(offset, offset + LOOKUP_CHUNK))
      .or("status.eq.prospect,is_dnc_locked.eq.true")
      .is("deleted_at", null);
    if (error) throw new Error(`Prospect eligibility check failed: ${error.message}`);
    rows.push(...((data ?? []) as unknown as EligibilityRow[]));
  }

  const rowById = new Map(rows.map((row) => [row.id, row]));
  const eligibleIds: string[] = [];
  const exclusions: ProspectEligibilityExclusion[] = [];
  let dncLockedCount = 0;
  let skipTraceDisabledCount = 0;
  let skippedLeadCount = 0;
  let prospectDncLockedCount = 0;
  const prospectDncLockedIds: string[] = [];

  for (const propertyId of uniqueIds) {
    const row = rowById.get(propertyId);
    if (!row || row.status !== "prospect") skippedLeadCount += 1;
    else if (row.is_dnc_locked) {
      prospectDncLockedCount += 1;
      prospectDncLockedIds.push(propertyId);
    }
    if (!row) {
      exclusions.push({ propertyId, reason: "not_found_or_not_prospect" });
      continue;
    }
    if (row.is_dnc_locked) {
      dncLockedCount += 1;
      exclusions.push({ propertyId, reason: "dnc" });
      continue;
    }
    if (purpose === "skip_trace" && row.skip_trace_disabled) {
      skipTraceDisabledCount += 1;
      exclusions.push({ propertyId, reason: "skip_trace_disabled" });
      continue;
    }
    eligibleIds.push(propertyId);
  }

  return {
    eligibleIds,
    exclusions,
    dncLockedCount,
    skipTraceDisabledCount,
    skippedLeadCount,
    prospectDncLockedCount,
    prospectDncLockedIds,
  };
}
