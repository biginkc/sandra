import { createAdminClient } from "@/lib/supabase/admin";
import { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";

export { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";

type MembershipRole = "owner" | "member";
type MembershipRow = { user_id: string; role: string };
type AdminClient = ReturnType<typeof createAdminClient>;

const PAGE_SIZE = 1_000;
const MAX_PAGES = 100;

/** Load the complete access inventory for Sandra's one canonical organization. */
export async function loadSandraMemberships(admin: AdminClient): Promise<{
  membershipByUser: Map<string, MembershipRole>;
  error: string | null;
}> {
  const membershipByUser = new Map<string, MembershipRole>();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await admin
      .from("memberships")
      .select("user_id,role")
      .eq("org_id", SANDRA_ORG_ID)
      .order("user_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      return { membershipByUser, error: error.message };
    }

    const rows = (data ?? []) as MembershipRow[];
    for (const membership of rows) {
      membershipByUser.set(
        membership.user_id,
        membership.role === "owner" ? "owner" : "member",
      );
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
