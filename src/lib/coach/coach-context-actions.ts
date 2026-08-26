"use server";

import type { User } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";
import type { CoachCallContext, CoachOccupancy } from "./types";

type CoachLeadRow = {
  address: string | null;
  source: string | null;
  is_vacant: boolean | null;
  absentee_flag: boolean | null;
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

/** Title-cases the auth email's local part ("jane.doe@" -> "Jane Doe") — the
 * fallback used until a rep sets a real display_name. */
function repNameFallbackFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const localPart = email.split("@")[0];
  if (!localPart) return null;
  return localPart
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ") || null;
}

/**
 * Sandra has no `profiles`/`team_members` table — the only per-user record
 * outside auth.users is `memberships`, which is Hugo's access/role ledger
 * (see admin/users/actions.ts: "Hugo owns account creation and access
 * grants") and isn't the right home for a cosmetic display name. Reps set
 * their own name via `supabase.auth.updateUser({ data: { display_name } })`
 * — the same auth.users user_metadata mechanism the password-reset flow
 * already uses (src/app/auth/set-password/actions.ts) — so it's self-service
 * with no new RLS policy needed. Falls back to the email-derived name until
 * a rep sets one.
 */
function repDisplayName(user: Pick<User, "email" | "user_metadata"> | null | undefined): string | null {
  const stored = user?.user_metadata?.display_name;
  if (typeof stored === "string" && stored.trim()) return stored.trim();
  return repNameFallbackFromEmail(user?.email);
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

  const [{ data: { user } }, leadResult] = await Promise.all([
    supabase.auth.getUser(),
    input.propertyId
      ? supabase
          .from("properties")
          .select(
            "address, source, is_vacant, absentee_flag, county:counties(name), homeowner:contacts!properties_homeowner_contact_id_fkey(first_name, last_name, entity_name)",
          )
          .eq("id", input.propertyId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  // A Supabase query error (RLS denial, network, bad column, …) resolves
  // without throwing — `data` comes back null exactly as it would for a
  // genuinely missing lead. Left unchecked, that silently degrades to an
  // all-placeholder context with no signal anything went wrong. Throwing
  // here routes it into the caller's existing "context failed to load"
  // retry-banner path instead of pretending the lead just has no data.
  if (leadResult.error) {
    reportError(leadResult.error, {
      tags: { surface: "coach_context_load" },
      extra: { propertyId: input.propertyId },
    });
    throw new Error(`Could not load lead details for the coach: ${leadResult.error.message}`);
  }

  const lead = leadResult.data as unknown as CoachLeadRow | null;

  return {
    sellerName: sellerName(lead?.homeowner ?? null),
    propertyAddress: lead?.address ?? null,
    propertyCounty: lead?.county?.name ?? null,
    repName: repDisplayName(user),
    repPhoneE164: input.repPhoneE164,
    // Sandra has no free-text seller-motivation field. properties.motivation_level
    // is a hot/warm/cold SCORE, not the seller's stated reason — mapping it to
    // {motivation} would put "warm" into a sentence expecting "downsizing" or
    // "job relocation". Until a real motivation/reason text column exists,
    // this always renders as a placeholder chip rather than the wrong value.
    motivation: null,
    leadId: input.propertyId,
    sellerPhoneE164: input.sellerPhoneE164,
    // No cold-caller field exists in Sandra's schema yet — always a
    // placeholder chip until one is added.
    coldCallerName: null,
    leadSource: lead?.source ?? null,
    occupancy: occupancy(lead),
  };
}
