import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

type AssignmentValidation =
  | { ok: true; propertyOrgIds: Map<string, string> }
  | { ok: false; code: "PROPERTY_NOT_FOUND" | "ASSIGNEE_VALIDATION_FAILED" | "INVALID_ASSIGNEE"; message: string };

/**
 * Resolve every requested property through the actor's RLS-scoped client,
 * then require the target assignee to have current access to every resolved
 * organization. The database trigger repeats the membership check at write
 * time to close the validation/update race.
 */
export async function validateActiveAssigneeForProperties(
  supabase: SupabaseClient<Database>,
  propertyIds: readonly string[],
  userId: string | null,
  nowIso = new Date().toISOString(),
): Promise<AssignmentValidation> {
  const uniquePropertyIds = Array.from(new Set(propertyIds));
  const { data: properties, error: propertiesError } = await supabase
    .from("properties")
    .select("id, org_id")
    .in("id", uniquePropertyIds)
    .is("deleted_at", null);
  if (propertiesError) {
    return {
      ok: false,
      code: "ASSIGNEE_VALIDATION_FAILED",
      message: "We couldn't verify those leads. Try again.",
    };
  }

  const propertyOrgIds = new Map((properties ?? []).map((row) => [row.id, row.org_id]));
  if (uniquePropertyIds.some((propertyId) => !propertyOrgIds.has(propertyId))) {
    return {
      ok: false,
      code: "PROPERTY_NOT_FOUND",
      message: "One or more leads could not be found.",
    };
  }
  if (!userId) return { ok: true, propertyOrgIds };

  const orgIds = Array.from(new Set(propertyOrgIds.values()));
  const admin = createAdminClient();
  const { data: memberships, error: membershipsError } = await admin
    .from("memberships")
    .select("org_id")
    .eq("user_id", userId)
    .in("org_id", orgIds)
    .eq("access_status", "active")
    .or(`access_expires_at.is.null,access_expires_at.gt.${nowIso}`);
  if (membershipsError) {
    return {
      ok: false,
      code: "ASSIGNEE_VALIDATION_FAILED",
      message: "We couldn't verify that teammate. Try again.",
    };
  }

  const memberOrgIds = new Set((memberships ?? []).map((membership) => membership.org_id));
  if (orgIds.some((orgId) => !memberOrgIds.has(orgId))) {
    return {
      ok: false,
      code: "INVALID_ASSIGNEE",
      message: "Choose a teammate with active access to every selected lead's workspace.",
    };
  }
  return { ok: true, propertyOrgIds };
}
