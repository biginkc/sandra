import { createAdminClient } from "@/lib/supabase/admin";
import { hasActiveSandraAccess } from "@/lib/auth/access-state";
import { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";

export { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";

type MembershipRole = "owner" | "member";
type MembershipRow = {
  user_id: string;
  role: string;
  access_status: string | null;
  access_expires_at: string | null;
  deletion_prepared_at: string | null;
};
export type SandraMembershipInventory = {
  role: MembershipRole;
  accessStatus: string;
  accessExpiresAt: string | null;
  deletionPreparedAt: string | null;
  hasActiveAccess: boolean;
};
export type SandraAccessLabel =
  "active" | "suspended" | "revoked" | "expired" | "deletion prepared";
type AdminClient = ReturnType<typeof createAdminClient>;

const PAGE_SIZE = 1_000;
const MAX_PAGES = 100;

export function describeSandraAccess(
  membership: SandraMembershipInventory,
  now = Date.now(),
): SandraAccessLabel {
  if (membership.deletionPreparedAt) return "deletion prepared";
  if (membership.accessStatus === "suspended") return "suspended";
  if (membership.accessStatus === "revoked") return "revoked";
  if (!membership.accessExpiresAt) return "active";

  const expiresAt = Date.parse(membership.accessExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now ? "active" : "expired";
}

/** Load the complete access inventory for Sandra's one canonical organization. */
export async function loadSandraMemberships(admin: AdminClient): Promise<{
  membershipByUser: Map<string, SandraMembershipInventory>;
  error: string | null;
}> {
  const membershipByUser = new Map<string, SandraMembershipInventory>();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await admin
      .from("memberships")
      .select(
        "user_id,role,access_status,access_expires_at,deletion_prepared_at",
      )
      .eq("org_id", SANDRA_ORG_ID)
      .order("user_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      return { membershipByUser, error: error.message };
    }

    const rows = (data ?? []) as MembershipRow[];
    for (const membership of rows) {
      membershipByUser.set(membership.user_id, {
        role: membership.role === "owner" ? "owner" : "member",
        accessStatus: membership.access_status ?? "active",
        accessExpiresAt: membership.access_expires_at,
        deletionPreparedAt: membership.deletion_prepared_at,
        hasActiveAccess: hasActiveSandraAccess(membership),
      });
    }

    if (rows.length < PAGE_SIZE) {
      return { membershipByUser, error: null };
    }
  }

  return {
    membershipByUser,
    error: "Membership inventory exceeded the supported page limit.",
  };
}
