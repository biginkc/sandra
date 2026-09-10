import "server-only";

import { cache } from "react";
import type { User } from "@supabase/supabase-js";

import {
  hasActiveSandraAccess,
  isMissingHugoAccessColumnError,
} from "@/lib/auth/access-state";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  sortTeamMembers,
  teamMemberFromAuthUser,
  type TeamMember,
} from "./team-member";

type MembershipRow = {
  user_id: string;
  access_status: string | null;
  access_expires_at: string | null;
  deletion_prepared_at: string | null;
};

const IDENTITY_CONCURRENCY = 4;
const TEAM_ROSTER_CAP = 400;

// React cache shares identities only within a Server Component request. It
// neither persists labels across requests nor caches membership eligibility.
const loadAuthIdentity = cache(async (id: string) => {
  const response = await createAdminClient().auth.admin.getUserById(id);
  if (!response) throw new Error("Auth identity returned no response.");
  if (response.error) throw response.error;
  return response.data?.user ?? null;
});

async function listNeededAuthUsers(
  neededIds: ReadonlySet<string>,
  allowPartial: boolean,
): Promise<Map<string, User>> {
  const usersById = new Map<string, User>();
  const ids = [...neededIds];
  if (ids.length > TEAM_ROSTER_CAP) {
    throw new Error("Organization identities exceeded the supported member limit.");
  }
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(IDENTITY_CONCURRENCY, ids.length) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        try {
          const user = await loadAuthIdentity(id);
          // Never accept an identity for a different member, even if the
          // upstream response is malformed.
          if (user && user.id !== id) throw new Error("Auth identity mismatch.");
          if (user) usersById.set(id, user);
        } catch (error) {
          if (!allowPartial) throw error;
        }
      }
    }),
  );
  return usersById;
}

/**
 * Resolve the current active org roster plus explicitly requested historical
 * assignees. Historical ids are display-only: callers must never feed them to
 * an assignment picker.
 */
export async function loadOrgTeamMembers(
  orgId: string,
  options: {
    historicalAssigneeIds?: readonly string[];
    includeInactiveMembers?: boolean;
    allowMissingIdentityLabels?: boolean;
  } = {},
): Promise<TeamMember[]> {
  if (!orgId) return [];

  const admin = createAdminClient();
  const membershipResult = await admin
    .from("memberships")
    .select("user_id, access_status, access_expires_at, deletion_prepared_at")
    .eq("org_id", orgId)
    .order("user_id", { ascending: true })
    .limit(TEAM_ROSTER_CAP + 1);
  let data = membershipResult.data;
  const { error } = membershipResult;
  if (error) {
    const allowLocalE2ePasswordSession =
      process.env.NODE_ENV !== "production" &&
      process.env.E2E_AUTH_BYPASS === "1";
    if (
      !allowLocalE2ePasswordSession ||
      !isMissingHugoAccessColumnError(error)
    ) {
      throw error;
    }
    const legacy = await admin
      .from("memberships")
      .select("user_id")
      .eq("org_id", orgId)
      .order("user_id", { ascending: true })
      .limit(TEAM_ROSTER_CAP + 1);
    if (legacy.error) throw legacy.error;
    data = (legacy.data ?? []).map((membership) => ({
      ...membership,
      access_status: "active",
      access_expires_at: null,
      deletion_prepared_at: null,
    }));
  }

  const memberships = (data ?? []) as MembershipRow[];
  if (memberships.length > TEAM_ROSTER_CAP) {
    throw new Error("Organization roster exceeded the supported member limit.");
  }
  const activeIds = new Set(
    memberships
      .filter((membership) => hasActiveSandraAccess(membership))
      .map((membership) => membership.user_id),
  );
  const historicalIds = options.historicalAssigneeIds ?? [];
  const inactiveMembershipIds = options.includeInactiveMembers
    ? memberships.map((membership) => membership.user_id)
    : [];
  const neededIds = new Set([
    ...activeIds,
    ...inactiveMembershipIds,
    // Historical ids must come from a row the caller already read through
    // tenant-scoped RLS (for example, the lead's stored owner). Membership
    // deletion must not erase the readable audit label for that row.
    ...historicalIds.filter(Boolean),
  ]);
  const usersById = await listNeededAuthUsers(
    neededIds,
    options.allowMissingIdentityLabels ?? false,
  );

  const members = [...neededIds].map((id) => {
    const user = usersById.get(id);
    if (user) return teamMemberFromAuthUser(user, activeIds.has(id));
    return {
      id,
      email: null,
      displayName: null,
      isActive: activeIds.has(id),
    } satisfies TeamMember;
  });

  if (
    !options.allowMissingIdentityLabels &&
    members.some((member) => !member.displayName && !member.email)
  ) {
    throw new Error(
      "An organization member has no verified identity label.",
    );
  }

  return sortTeamMembers(members);
}

/**
 * Merge explicitly scoped organization rosters for cross-org pages. A user
 * keeps one stable option; active membership wins over former membership.
 */
export async function loadTeamMembersForOrgs(
  orgIds: readonly string[],
  options: Parameters<typeof loadOrgTeamMembers>[1] = {},
): Promise<TeamMember[]> {
  const uniqueOrgIds = [...new Set(orgIds.filter(Boolean))];
  const rosters = await Promise.all(
    uniqueOrgIds.map((orgId) => loadOrgTeamMembers(orgId, options)),
  );
  const byId = new Map<string, TeamMember>();
  for (const member of rosters.flat()) {
    const current = byId.get(member.id);
    if (!current || (current.isActive === false && member.isActive !== false)) {
      byId.set(member.id, member);
    }
  }
  return sortTeamMembers([...byId.values()]);
}
