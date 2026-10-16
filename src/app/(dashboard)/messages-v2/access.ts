import {
  getCallerMembershipsOrThrow,
  type Membership,
} from "@/lib/auth/memberships";
import { hasActiveSandraAccess } from "@/lib/auth/access-state";
import { isAcquisitionsCaller } from "@/lib/auth/surface-access";

/**
 * Messages v2 is visible to org owners and to the Acquisitions group. The
 * legacy Messages gate (canAccessMessagesAndLeadsBoard) denies Acquisitions
 * members, so it cannot be reused here. Empty / inactive memberships are
 * denied (fail closed).
 */
export function canAccessMessagesV2(
  memberships: readonly Membership[],
): boolean {
  return memberships
    .filter((membership) => hasActiveSandraAccess(membership))
    .some(
      (membership) =>
        membership.role === "owner" || isAcquisitionsCaller(membership),
    );
}

/** Org the caller may view Messages v2 for (first qualifying active membership), or null. */
export function messagesV2OrgId(
  memberships: readonly Membership[],
): string | null {
  const allowed = memberships.find(
    (membership) =>
      hasActiveSandraAccess(membership) &&
      (membership.role === "owner" || isAcquisitionsCaller(membership)),
  );
  return allowed?.org_id ?? null;
}

/**
 * Org plus whether the caller is an owner there. Owners may also open the
 * legacy /messages thread; Acquisitions callers are denied that surface and
 * are linked to the lead page instead. An owner membership wins.
 */
export function messagesV2Context(
  memberships: readonly Membership[],
): { orgId: string; isOwner: boolean } | null {
  const active = memberships.filter((membership) =>
    hasActiveSandraAccess(membership),
  );
  const owner = active.find((membership) => membership.role === "owner");
  if (owner) return { orgId: owner.org_id, isOwner: true };
  const acq = active.find((membership) => isAcquisitionsCaller(membership));
  return acq ? { orgId: acq.org_id, isOwner: false } : null;
}

export class MessagesV2AccessError extends Error {
  constructor() {
    super("Messages v2 access is unavailable.");
    this.name = "MessagesV2AccessError";
  }
}

/** Fail-closed server guard; resolves to the org id the page should read. */
export async function assertMessagesV2Access(): Promise<string> {
  const orgId = messagesV2OrgId(await getCallerMembershipsOrThrow());
  if (!orgId) throw new MessagesV2AccessError();
  return orgId;
}
