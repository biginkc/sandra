"use server";

import { createClient } from "@/lib/supabase/server";
import type { CoachCallContext } from "./types";

type CoachLeadRow = {
  address: string | null;
  motivation_level: string | null;
  county: { name: string } | null;
  homeowner: { first_name: string | null; last_name: string | null; entity_name: string | null } | null;
};

/** Sandra has no rep display-name field yet (no profiles/team_members
 * table) — best we can do today is title-case the auth email's local part.
 * Swap this for a real name field the moment one exists. */
function repNameFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const localPart = email.split("@")[0];
  if (!localPart) return null;
  return localPart
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ") || null;
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
    repName: repNameFromEmail(user?.email),
    repPhoneE164: input.repPhoneE164,
    motivation: lead?.motivation_level ?? null,
    leadId: input.propertyId,
    sellerPhoneE164: input.sellerPhoneE164,
  };
}
