import "server-only";

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

const AUTH_PAGE_SIZE = 200;
const MAX_AUTH_PAGES = 25;
const TEAM_ROSTER_CAP = 400;

async function listNeededAuthUsers(
  neededIds: ReadonlySet<string>,
  allowPartial: boolean,
): Promise<Map<string, User>> {
  const usersById = new Map<string, User>();
  if (neededIds.size === 0) return usersById;

  const admin = createAdminClient();
  for (let page = 1; page <= MAX_AUTH_PAGES; page += 1) {
    let response;
    try {
      response = await admin.auth.admin.listUsers({
        page,
        perPage: AUTH_PAGE_SIZE,
      });
    } catch (error) {
      if (allowPartial) return usersById;
      throw error;
    }
    if (!response) {
      if (allowPartial) return usersById;
      throw new Error("Auth user inventory returned no response.");
    }
    const { data, error } = response;
    if (error) {
      if (allowPartial) return usersById;
      throw error;
    }

    const users = data?.users ?? [];
    for (const user of users) {
      if (neededIds.has(user.id)) usersById.set(user.id, user);
    }
    const nextPage = data?.nextPage;
    const exhausted =
      nextPage === null ||
      (nextPage === undefined && users.length < AUTH_PAGE_SIZE);
    if (usersById.size === neededIds.size || exhausted) {
      return usersById;
    }
  }

  if (allowPartial) return usersById;
  throw new Error("Auth user inventory exceeded the supported page limit.");
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
