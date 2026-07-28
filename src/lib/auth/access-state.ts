export type SandraAccessStatus = "active" | "suspended" | "revoked";

export type SandraMembershipAccess = {
  access_status?: string | null;
  access_expires_at?: string | null;
  deletion_prepared_at?: string | null;
};

/**
 * Membership existence is not enough to authorize a request. Hugo may leave
 * a desired grant active while its expiration has passed, and suspend/revoke
 * must deny immediately. The optional-field fallback keeps old test fixtures
 * and pre-migration local snapshots readable; the migration makes these
 * fields non-null for every production membership.
 */
export function hasActiveSandraAccess(
  membership: SandraMembershipAccess | null | undefined,
  now = Date.now(),
): boolean {
  if (!membership) return false;
  const status = membership.access_status ?? "active";
  if (status !== "active") return false;
  if (membership.deletion_prepared_at) return false;
  if (!membership.access_expires_at) return true;
  const expiresAt = Date.parse(membership.access_expires_at);
  return Number.isFinite(expiresAt) && expiresAt > now;
}
