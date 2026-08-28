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
  year_built: number | null;
  county: { name: string } | null;
  homeowner: { first_name: string | null; last_name: string | null; entity_name: string | null } | null;
};

/**
 * Explicit v1 roster values supplied by BMH for reps whose Hugo-provisioned
 * Auth identity predates display-name metadata. This is intentionally small
 * and server-only; user_metadata.display_name remains authoritative whenever
 * it exists.
 */
const KNOWN_REP_NAMES_BY_EMAIL = new Map<string, string>([
  ["jarrad@bmhgroupkc.com", "Jarrad Henry"],
]);

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

/**
 * Title-cases a clearly delimited auth email local part
 * ("jane.doe@" -> "Jane Doe"). A single token such as "jarrad@" is only a
 * likely first name, so treating it as the rep's complete known name would
 * silently put incorrect wording into the script. Fail safe to the visible
 * placeholder until authoritative auth metadata is populated instead.
 */
function repNameFallbackFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const localPart = email.split("@")[0];
  if (!localPart) return null;
  const parts = localPart
    .split(/[._+-]+/)
    .filter(Boolean);
  if (parts.length < 2) return null;
  return parts
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ") || null;
}

/**
 * Sandra has no `profiles`/`team_members` table — the only per-user record
 * outside auth.users is `memberships`, which is Hugo's access/role ledger
 * (see admin/users/actions.ts: "Hugo owns account creation and access
 * grants") and contains no person name. `auth.users.user_metadata.display_name`
 * is therefore the authoritative existing source, followed by BMH's explicit
 * v1 roster for pre-metadata accounts. A clearly delimited email can supply a
 * safe last fallback; ambiguous single-token email locals cannot.
 */
function repDisplayName(user: Pick<User, "email" | "user_metadata"> | null | undefined): string | null {
  const stored = user?.user_metadata?.display_name;
  if (typeof stored === "string" && stored.trim()) return stored.trim();
  const known = user?.email ? KNOWN_REP_NAMES_BY_EMAIL.get(user.email.trim().toLowerCase()) : null;
  if (known) return known;
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
    yearBuilt: lead?.year_built != null ? String(lead.year_built) : null,
    leadSource: lead?.source ?? null,
    occupancy: occupancy(lead),
  };
}
