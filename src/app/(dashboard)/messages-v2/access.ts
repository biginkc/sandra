import { getCallerMembershipsOrThrow, type Membership } from "@/lib/auth/memberships";
import { hasActiveSandraAccess } from "@/lib/auth/access-state";
import { isAcquisitionsCaller } from "@/lib/auth/surface-access";

/**
 * Messages v2 is visible to org owners and to the Acquisitions group. The
 * legacy Messages gate (canAccessMessagesAndLeadsBoard) denies Acquisitions
 * members, so it cannot be reused here. Empty / inactive memberships are
 * denied (fail closed).
 */
export function canAccessMessagesV2(memberships: readonly Membership[]): boolean {
  return memberships
    .filter((membership) => hasActiveSandraAccess(membership))
    .some((membership) => membership.role === "owner" || isAcquisitionsCaller(membership));
}

/** Org the caller may view Messages v2 for (first qualifying active membership), or null. */
export function messagesV2OrgId(memberships: readonly Membership[]): string | null {
  const allowed = memberships.find(
    (membership) =>
      hasActiveSandraAccess(membership) &&
      (membership.role === "owner" || isAcquisitionsCaller(membership)),
  );
  return allowed?.org_id ?? null;
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
