import { createClient } from "@/lib/supabase/server";

export type Membership = {
  user_id: string;
  org_id: string;
  role: "owner" | "member";
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
    .select("user_id, org_id, role");
  return data ?? [];
}
