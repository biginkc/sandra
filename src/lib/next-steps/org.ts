import "server-only";

import {
  requireOrgMembership,
  requireOrgMembershipByResource,
} from "@/lib/auth/require-org-membership";
import { err, ok, type Result } from "@/lib/errors/result";
import type { createClient } from "@/lib/supabase/server";

/**
 * Org resolution shared by `bookAppointment` and `listBookingAssignees`
 * (Codex round 2, assignee-picker scoping): linked bookings derive org
 * from the resource; a personal block (no property, no contact — locked
 * decision #5) falls back to the caller's own single ACTIVE membership,
 * erroring explicitly on zero or multiple memberships rather than
 * guessing. Active-only (R2-2 hardening, Codex round 1): a stale/suspended
 * membership row must not count toward "which org" — without this filter,
 * a caller who is active in one org and merely has HISTORY (suspended,
 * expired, deletion-prepared) in another would see two rows and get a
 * spurious AMBIGUOUS_ORG, or worse, could resolve into an org they no
 * longer have access to. Same active-membership predicates as
 * hasActiveSandraAccess / getCallerMemberships, expressed as PostgREST
 * filters (mirrors updateMembershipRole in admin/users/actions.ts).
 */
export async function resolveBookingOrgId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  user: { id: string },
  ctx: { propertyId?: string; contactId?: string },
): Promise<Result<string>> {
  if (ctx.propertyId) {
    const { orgId } = await requireOrgMembershipByResource(
      "properties",
      ctx.propertyId,
    );
    return ok(orgId);
  }
  if (ctx.contactId) {
    const { orgId } = await requireOrgMembershipByResource(
      "contacts",
      ctx.contactId,
    );
    return ok(orgId);
  }

  const activeAt = new Date().toISOString();
  const { data: memberships, error: membershipErr } = await supabase
    .from("memberships")
    .select("org_id")
    .eq("user_id", user.id)
    .eq("access_status", "active")
    .is("deletion_prepared_at", null)
    .or(`access_expires_at.is.null,access_expires_at.gt.${activeAt}`);
  if (membershipErr) {
    return err({
      code: "MEMBERSHIP_LOOKUP_FAILED",
      message: membershipErr.message,
    });
  }
  if (!memberships || memberships.length !== 1) {
    return err({
      code: "AMBIGUOUS_ORG",
      message:
        memberships && memberships.length > 1
          ? "You belong to more than one org — book from a linked lead or contact instead."
          : "You don't belong to an org.",
    });
  }
  const { orgId } = await requireOrgMembership(memberships[0].org_id);
  return ok(orgId);
}
