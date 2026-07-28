import { createClient } from "@/lib/supabase/server";
import { hasActiveSandraAccess } from "@/lib/auth/access-state";

export type Membership = {
  user_id: string;
  org_id: string;
  role: "owner" | "member";
  access_status?: string | null;
  access_expires_at?: string | null;
  deletion_prepared_at?: string | null;
};

type MembershipReader = {
  from(table: "memberships"): {
    select(columns: string): Promise<{ data: Membership[] | null }>;
  };
};

export async function getCallerMemberships(): Promise<Membership[]> {
  const supabase = await createClient();
  const { data } = await (supabase as unknown as MembershipReader)
    .from("memberships")
    .select(
      "user_id, org_id, role, access_status, access_expires_at, deletion_prepared_at",
    );
  return (data ?? []).filter((membership) => hasActiveSandraAccess(membership));
}
