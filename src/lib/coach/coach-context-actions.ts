"use server";

import type { User } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import type { CoachCallContext } from "./types";

type CoachLeadRow = {
  address: string | null;
  motivation_level: string | null;
  county: { name: string } | null;
  homeowner: { first_name: string | null; last_name: string | null; entity_name: string | null } | null;
};

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
            "address, motivation_level, county:counties(name), homeowner:contacts!properties_homeowner_contact_id_fkey(first_name, last_name, entity_name)",
          )
          .eq("id", input.propertyId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const lead = leadResult.data as unknown as CoachLeadRow | null;

  return {
    sellerName: sellerName(lead?.homeowner ?? null),
    propertyAddress: lead?.address ?? null,
    propertyCounty: lead?.county?.name ?? null,
    repName: repDisplayName(user),
    repPhoneE164: input.repPhoneE164,
    motivation: lead?.motivation_level ?? null,
    leadId: input.propertyId,
    sellerPhoneE164: input.sellerPhoneE164,
  };
}
