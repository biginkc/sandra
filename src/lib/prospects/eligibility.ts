import type { SupabaseClient } from "@supabase/supabase-js";

import { evaluateSuppression } from "@/lib/messaging/suppression";
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
};

type EligibilityRow = {
  id: string;
  org_id: string;
  outreach_dispo: string | null;
  skip_trace_disabled: boolean;
  homeowner: Array<{
    phone_1: string | null;
    phone_2: string | null;
    phone_3: string | null;
    do_not_contact: boolean;
    sms_opted_out: boolean;
  }> | {
    phone_1: string | null;
    phone_2: string | null;
    phone_3: string | null;
    do_not_contact: boolean;
    sms_opted_out: boolean;
  } | null;
};

const LOOKUP_CHUNK = 500;

function homeownerFor(row: EligibilityRow) {
  return Array.isArray(row.homeowner) ? row.homeowner[0] ?? null : row.homeowner;
}

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
    };
  }

  const rows: EligibilityRow[] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from("properties")
      .select(
        "id, org_id, outreach_dispo, skip_trace_disabled, homeowner:contacts!properties_homeowner_contact_id_fkey(phone_1, phone_2, phone_3, do_not_contact, sms_opted_out)",
      )
      .in("id", uniqueIds.slice(offset, offset + LOOKUP_CHUNK))
      .eq("status", "prospect")
      .is("deleted_at", null);
    if (error) throw new Error(`Prospect eligibility check failed: ${error.message}`);
    rows.push(...((data ?? []) as unknown as EligibilityRow[]));
  }

  const phones = Array.from(new Set(rows.flatMap((row) => {
    const homeowner = homeownerFor(row);
    return homeowner
      ? [homeowner.phone_1, homeowner.phone_2, homeowner.phone_3].filter(
          (phone): phone is string => !!phone,
        )
      : [];
  })));
  const suppressedPhones = new Set<string>();
  for (let offset = 0; offset < phones.length; offset += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from("sms_phone_suppressions")
      .select("org_id, phone_e164")
      .eq("channel", "sms")
      .in("phone_e164", phones.slice(offset, offset + LOOKUP_CHUNK));
    if (error) throw new Error(`Prospect suppression check failed: ${error.message}`);
    for (const row of data ?? []) {
      suppressedPhones.add(`${row.org_id}:${row.phone_e164}`);
    }
  }

  const rowById = new Map(rows.map((row) => [row.id, row]));
  const eligibleIds: string[] = [];
  const exclusions: ProspectEligibilityExclusion[] = [];
  let dncLockedCount = 0;
  let skipTraceDisabledCount = 0;

  for (const propertyId of uniqueIds) {
    const row = rowById.get(propertyId);
    if (!row) {
      exclusions.push({ propertyId, reason: "not_found_or_not_prospect" });
      continue;
    }
    const homeowner = homeownerFor(row);
    const durableSuppression = [
      homeowner?.phone_1,
      homeowner?.phone_2,
      homeowner?.phone_3,
    ].some(
      (phone) => !!phone && suppressedPhones.has(`${row.org_id}:${phone}`),
    );
    const dncLocked =
      durableSuppression ||
      evaluateSuppression({
        outreachDispo: row.outreach_dispo,
        doNotContact: homeowner?.do_not_contact,
        smsOptedOut: homeowner?.sms_opted_out,
      }).suppressed;
    if (dncLocked) {
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

  return { eligibleIds, exclusions, dncLockedCount, skipTraceDisabledCount };
}
