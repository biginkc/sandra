import { createClient } from "@/lib/supabase/server";
import {
  hasActiveSandraAccess,
  isMissingHugoAccessColumnError,
} from "@/lib/auth/access-state";

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
    select(columns: string): Promise<{
      data: Membership[] | null;
      error: { code?: string; message?: string } | null;
    }>;
  };
};

export async function getCallerMemberships(): Promise<Membership[]> {
  const supabase = await createClient();
  const reader = supabase as unknown as MembershipReader;
  const hugoRequired = process.env.NEXT_PUBLIC_HUGO_SSO === "1";
  if (!hugoRequired) {
    const legacy = await reader.from("memberships").select("user_id, org_id, role");
    return legacy.error ? [] : legacy.data ?? [];
  }

  const { data, error } = await reader
    .from("memberships")
    .select(
      "user_id, org_id, role, access_status, access_expires_at, deletion_prepared_at",
    );
  if (!error) {
    return (data ?? []).filter((membership) => hasActiveSandraAccess(membership));
  }

  // Pull-request E2E runs intentionally use the shared project before the
  // Hugo migrations land. Preserve the password-session test lane's existing
  // membership access without weakening production behavior: a production
  // schema mismatch remains an empty (fail-closed) membership set.
  const allowLocalE2ePasswordSession =
    process.env.NODE_ENV !== "production" && process.env.E2E_AUTH_BYPASS === "1";
  if (!allowLocalE2ePasswordSession || !isMissingHugoAccessColumnError(error)) {
    return [];
  }

  const legacy = await reader.from("memberships").select("user_id, org_id, role");
  return legacy.error ? [] : legacy.data ?? [];
}
