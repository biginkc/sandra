import { hasActiveSandraAccess } from "./access-state";
import type { Membership } from "./memberships";

export type LeadDetailCollection = {
  href: "/leads" | "/properties" | "/my-leads";
  label: "Leads" | "Prospects" | "My Leads";
};

/**
 * Acquisitions designation is an access boundary for the shared workspace,
 * while the My Leads rollout flag controls whether its queue is usable. Keep
 * those decisions separate so an owner bypass in canViewMyLeads cannot grant
 * or remove workspace access accidentally.
 */
export function isActiveAcquisitionsMember(
  membership: Pick<Membership, "role" | "acquisitions_enabled"> & {
    access_status?: string | null;
    access_expires_at?: string | null;
    deletion_prepared_at?: string | null;
  },
): boolean {
  return (
    membership.role === "member" &&
    membership.acquisitions_enabled === true &&
    hasActiveSandraAccess(membership)
  );
}

/**
 * Owners retain the shared Messages and Leads board. A non-owner is scoped
 * away from both surfaces only when their active membership is Acquisitions.
 * The page boundary separately requires at least one active membership, so a
 * failed or empty membership lookup cannot silently grant a shared surface.
 */
export function shouldRestrictMessagesAndLeadsBoard(
  memberships: readonly Membership[],
): boolean {
  const activeMemberships = memberships.filter(hasActiveSandraAccess);
  if (activeMemberships.some((membership) => membership.role === "owner")) {
    return false;
  }
  return activeMemberships.some(isActiveAcquisitionsMember);
}

/**
 * Authoritative page/nav decision for the shared workspace surfaces. The
 * empty case is denied because it represents an unauthenticated caller, a
 * missing grant, or a failed membership lookup after the caller has already
 * passed the dashboard auth check.
 */
export function canAccessMessagesAndLeadsBoard(
  memberships: readonly Membership[],
): boolean {
  const activeMemberships = memberships.filter(hasActiveSandraAccess);
  if (activeMemberships.length === 0) return false;
  if (activeMemberships.some((membership) => membership.role === "owner")) {
    return true;
  }
  return !activeMemberships.some(isActiveAcquisitionsMember);
}

export function leadDetailCollection(
  isAcquisitionMember: boolean,
  mode: "prospect" | "lead" = "lead",
): LeadDetailCollection {
  if (isAcquisitionMember) return { href: "/my-leads", label: "My Leads" };
  return mode === "prospect"
    ? { href: "/properties", label: "Prospects" }
    : { href: "/leads", label: "Leads" };
}
