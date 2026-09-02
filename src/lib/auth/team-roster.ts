import "server-only";

import type { User } from "@supabase/supabase-js";

import { hasActiveSandraAccess } from "@/lib/auth/access-state";
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
  const { data, error } = await admin
    .from("memberships")
    .select("user_id, access_status, access_expires_at, deletion_prepared_at")
    .eq("org_id", orgId)
    .order("user_id", { ascending: true })
    .limit(TEAM_ROSTER_CAP + 1);
  if (error) throw error;

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

  return sortTeamMembers(members);
}
