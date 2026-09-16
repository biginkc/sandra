import { createClient } from "@/lib/supabase/server";
import {
  hasActiveSandraAccess,
  isMissingHugoAccessColumnError,
} from "@/lib/auth/access-state";

export type Membership = {
  user_id: string;
  org_id: string;
  role: "owner" | "member";
  /** Protected Acquisitions designation. This is separate from My Leads rollout state. */
  acquisitions_enabled?: boolean | null;
  access_status?: string | null;
  access_expires_at?: string | null;
  deletion_prepared_at?: string | null;
};

export type SingleActiveMembershipResolution =
  | { ok: true; membership: Membership }
  | { ok: false; reason: "missing" | "ambiguous" };

type MembershipReader = {
  from(table: "memberships"): {
    select(columns: string): Promise<{
      data: Membership[] | null;
      error: { code?: string; message?: string } | null;
    }>;
  };
};

export type CallerMembershipsResult =
  | { memberships: Membership[]; error: null }
  | { memberships: []; error: { code?: string; message?: string } };

/**
 * Preserve the legacy array API for existing callers while exposing lookup
 * failures to security-sensitive surfaces. An empty result is a valid denial;
 * a failed query must remain distinguishable so those surfaces can retry.
 */
export async function readCallerMemberships(): Promise<CallerMembershipsResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { memberships: [], error: null };

  const callerMemberships = (memberships: Membership[] | null): Membership[] =>
    (memberships ?? []).filter((membership) => membership.user_id === user.id);
  const reader = supabase as unknown as MembershipReader;
  const hugoRequired = process.env.NEXT_PUBLIC_HUGO_SSO === "1";
  if (!hugoRequired) {
    const legacy = await reader
      .from("memberships")
      .select("user_id, org_id, role, acquisitions_enabled");
    if (!legacy.error) return { memberships: callerMemberships(legacy.data), error: null };

    // The acquisition designation migration may lag in a local legacy
    // database. Preserve the pre-designation membership shape there; the
    // access helper then keeps the existing behavior for that schema.
    if (!isMissingAcquisitionDesignationColumnError(legacy.error)) return { memberships: [], error: legacy.error };
    const preAcquisition = await reader
      .from("memberships")
      .select("user_id, org_id, role");
    return preAcquisition.error
      ? { memberships: [], error: preAcquisition.error }
      : { memberships: callerMemberships(preAcquisition.data), error: null };
  }

  const { data, error } = await reader
    .from("memberships")
    .select(
      "user_id, org_id, role, acquisitions_enabled, access_status, access_expires_at, deletion_prepared_at",
    );
  if (!error) {
    return {
      memberships: callerMemberships(data).filter((membership) => hasActiveSandraAccess(membership)),
      error: null,
    };
  }

  // Pull-request E2E runs intentionally use the shared project before the
  // Hugo migrations land. Preserve the password-session test lane's existing
  // membership access without weakening production behavior: a production
  // schema mismatch remains an empty (fail-closed) membership set.
  const allowLocalE2ePasswordSession =
    process.env.NODE_ENV !== "production" && process.env.E2E_AUTH_BYPASS === "1";
  if (
    !allowLocalE2ePasswordSession ||
    (!isMissingHugoAccessColumnError(error) &&
      !isMissingAcquisitionDesignationColumnError(error))
  ) {
    return { memberships: [], error };
  }

  const legacy = await reader
    .from("memberships")
    .select("user_id, org_id, role, acquisitions_enabled");
  if (!legacy.error) return { memberships: callerMemberships(legacy.data), error: null };
  if (!isMissingAcquisitionDesignationColumnError(legacy.error)) return { memberships: [], error: legacy.error };
  const preAcquisition = await reader
    .from("memberships")
    .select("user_id, org_id, role");
  return preAcquisition.error
    ? { memberships: [], error: preAcquisition.error }
    : { memberships: callerMemberships(preAcquisition.data), error: null };
}

export async function getCallerMemberships(): Promise<Membership[]> {
  return (await readCallerMemberships()).memberships;
}

export class MembershipLookupError extends Error {
  constructor(public readonly cause: { code?: string; message?: string }) {
    super("Membership access could not be verified. Please retry.");
    this.name = "MembershipLookupError";
  }
}

export async function getCallerMembershipsOrThrow(): Promise<Membership[]> {
  const result = await readCallerMemberships();
  if (result.error) throw new MembershipLookupError(result.error);
  return result.memberships;
}

function isMissingAcquisitionDesignationColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const code = typeof candidate.code === "string" ? candidate.code : "";
  return (
    (code === "PGRST204" || /schema cache|does not exist/i.test(message)) &&
    /acquisitions_enabled/i.test(message)
  );
}

export function resolveSingleActiveMembership(
  memberships: readonly Membership[],
): SingleActiveMembershipResolution {
  if (memberships.length === 0) return { ok: false, reason: "missing" };
  if (memberships.length !== 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, membership: memberships[0] };
}

export async function getSingleActiveMembership(): Promise<SingleActiveMembershipResolution> {
  return resolveSingleActiveMembership(await getCallerMemberships());
}
