import { AuthorizationError } from "@/lib/errors/classes";
import { createClient } from "@/lib/supabase/server";

export type ResolvedMembership = {
  userId: string;
  orgId: string;
  role: "owner" | "member";
};

type ResourceTable =
  | "properties"
  | "messages"
  | "jobs"
  | "sequences"
  | "sequence_enrollments"
  | "sequence_step_runs"
  | "csv_imports"
  | "lists"
  | "tasks"
  | "lead_notes";

type MembershipLookupClient = {
  from(table: "memberships"): {
    select(columns: "role"): {
      eq(column: "user_id", value: string): {
        eq(column: "org_id", value: string): {
          maybeSingle(): Promise<{ data: { role: string } | null }>;
        };
      };
    };
  };
};

type ResourceLookupClient = {
  from(table: ResourceTable): {
    select(columns: "org_id"): {
      eq(column: "id", value: string): {
        maybeSingle(): Promise<{ data: { org_id: string } | null }>;
      };
    };
  };
};

export async function requireOrgMembership(
  orgId: string,
): Promise<ResolvedMembership> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new AuthorizationError("Not authenticated", { reason: "no_session" });
  }

  const { data } = await (supabase as unknown as MembershipLookupClient)
    .from("memberships")
    .select("role")
    .eq("user_id", user.id)
    .eq("org_id", orgId)
    .maybeSingle();

  if (!data) {
    throw new AuthorizationError("Forbidden", { reason: "not_member" });
  }

  return { userId: user.id, orgId, role: data.role as "owner" | "member" };
}

export async function requireOrgMembershipByResource(
  table: ResourceTable,
  resourceId: string,
): Promise<ResolvedMembership & { resourceId: string }> {
  const supabase = await createClient();
  const { data: row } = await (supabase as unknown as ResourceLookupClient)
    .from(table)
    .select("org_id")
    .eq("id", resourceId)
    .maybeSingle();

  if (!row) {
    throw new AuthorizationError("Forbidden", {
      reason: "no_resource_or_cross_tenant",
    });
  }

  const membership = await requireOrgMembership(
    (row as { org_id: string }).org_id,
  );
  return { ...membership, resourceId };
}
