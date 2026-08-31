"use server";

import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";
import { repDisplayName, repFileNumberIdentity } from "./rep-display-name";
import type { CoachCallContext, CoachOccupancy } from "./types";

type CoachLeadRow = {
  address: string | null;
  source: string | null;
  is_vacant: boolean | null;
  absentee_flag: boolean | null;
  year_built: number | null;
  county: { name: string } | null;
  homeowner: { first_name: string | null; last_name: string | null; entity_name: string | null } | null;
};

/**
 * Drives the Reveal phase's Entry branch auto-selection. `is_vacant` must
 * be explicitly `false` (positively confirmed, not merely absent/unscored)
 * before `absentee_flag` is trusted to distinguish owner vs tenant —
 * `absentee_flag` only means the mailing address differs from the property
 * address, which is equally consistent with "has tenants" or "sits vacant
 * and we just haven't scored it yet". Trusting absentee_flag alone
 * previously mislabeled an unscored-vacancy lead as tenant-occupied.
 */
function occupancy(lead: CoachLeadRow | null): CoachOccupancy | null {
  if (!lead) return null;
  if (lead.is_vacant === true) return "vacant";
  if (lead.is_vacant === false && lead.absentee_flag === false) return "owner_occupied";
  if (lead.is_vacant === false && lead.absentee_flag === true) return "tenant_occupied";
  return "unknown";
}

function sellerName(homeowner: CoachLeadRow["homeowner"]): string | null {
  if (!homeowner) return null;
  if (homeowner.entity_name?.trim()) return homeowner.entity_name.trim();
  return [homeowner.first_name, homeowner.last_name].filter(Boolean).join(" ") || null;
}

/**
 * Loads the token-resolver context for one call, at dial time. Called once
 * when the coach view mounts for a live call — not on every render.
 */
export async function loadCoachCallContext(input: {
  propertyId: string | null;
  sellerPhoneE164: string | null;
  repPhoneE164: string | null;
}): Promise<CoachCallContext> {
  const supabase = await createClient();

  const [{ data: { user }, error: userError }, leadResult] = await Promise.all([
    supabase.auth.getUser(),
    input.propertyId
      ? supabase
          .from("properties")
          .select(
            "address, source, is_vacant, absentee_flag, year_built, county:counties(name), homeowner:contacts!properties_homeowner_contact_id_fkey(first_name, last_name, entity_name)",
          )
          .eq("id", input.propertyId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  // A Supabase auth or query error (RLS denial, network, expired/invalid
  // session, bad column, …) resolves without throwing — `user`/`data` come
  // back null exactly as they would for a genuinely absent session/lead.
  // Left unchecked, that silently degrades to an all-placeholder context
  // (repName included) with no signal anything went wrong. Throwing here
  // routes it into the caller's existing "context failed to load"
  // retry-banner path instead of pretending the rep has no session or the
  // lead has no data.
  if (userError) {
    reportError(userError, {
      tags: { surface: "coach_context_load" },
      extra: { propertyId: input.propertyId, stage: "auth_get_user" },
    });
    throw new Error(`Could not verify your session for the coach: ${userError.message}`);
  }
  if (leadResult.error) {
    reportError(leadResult.error, {
      tags: { surface: "coach_context_load" },
      extra: { propertyId: input.propertyId },
    });
    throw new Error(`Could not load lead details for the coach: ${leadResult.error.message}`);
  }

  const lead = leadResult.data as unknown as CoachLeadRow | null;
  const authenticatedRepName = repFileNumberIdentity(user);

  return {
    sellerName: sellerName(lead?.homeowner ?? null),
    propertyAddress: lead?.address ?? null,
    propertyCounty: lead?.county?.name ?? null,
    repName: repDisplayName(user),
    authenticatedRepName,
    repPhoneE164: input.repPhoneE164,
    // Sandra has no free-text seller-motivation field. properties.motivation_level
    // is a hot/warm/cold SCORE, not the seller's stated reason — mapping it to
    // {motivation} would put "warm" into a sentence expecting "downsizing" or
    // "job relocation". Until a real motivation/reason text column exists,
    // this always renders as a placeholder chip rather than the wrong value.
    motivation: null,
    leadId: lead ? input.propertyId : null,
    sellerPhoneE164: input.sellerPhoneE164,
    // No cold-caller field exists in Sandra's schema yet — always a
    // placeholder chip until one is added.
    coldCallerName: null,
    yearBuilt: lead?.year_built != null ? String(lead.year_built) : null,
    leadSource: lead?.source ?? null,
    occupancy: occupancy(lead),
  };
}
