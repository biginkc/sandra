import type { User } from "@supabase/supabase-js";

export type TeamMember = {
  id: string;
  email: string | null;
  /** Optional only for legacy callers/tests; roster loaders always set it. */
  displayName?: string | null;
  /** Omitted means active for backwards-compatible presentation inputs. */
  isActive?: boolean;
};

type AuthIdentity = Pick<User, "id" | "email" | "user_metadata"> & {
  app_metadata?: User["app_metadata"];
};

function cleanMetadataValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Use only names supplied by the identity provider or an administrator.
 * Email-local-part title-casing is intentionally forbidden: it invents a
 * person's name and is especially misleading for shared or role accounts.
 */
export function authoritativeDisplayName(
  user:
    | {
        user_metadata?: User["user_metadata"];
        app_metadata?: User["app_metadata"];
        email?: string | null;
      }
    | null
    | undefined,
): string | null {
  const administratorMetadata = user?.app_metadata ?? {};
  for (const key of ["display_name", "full_name", "name"] as const) {
    const value = cleanMetadataValue(administratorMetadata[key]);
    if (value) return value;
  }
  // Supabase user_metadata is editable by the signed-in user. It must never
  // become an authoritative assignment label. Legacy administrator-entered
  // names are sealed into app_metadata by the reviewed one-time migration;
  // until then, the verified email is the honest fallback.
  return null;
}

export function teamMemberFromAuthUser(
  user: AuthIdentity,
  isActive: boolean,
): TeamMember {
  return {
    id: user.id,
    email: cleanMetadataValue(user.email)?.toLowerCase() ?? null,
    displayName: authoritativeDisplayName(user),
    isActive,
  };
}

export function teamMemberPrimaryLabel(
  member: TeamMember,
  currentUserId: string | null = null,
): string {
  const identity = member.displayName ?? member.email ?? "Name not set";
  const selfSuffix = member.id === currentUserId ? " (you)" : "";
  const formerSuffix = member.isActive === false ? " (former)" : "";
  return `${identity}${selfSuffix}${formerSuffix}`;
}

/** Compact text for native selects, which cannot render a two-line label. */
export function teamMemberOptionLabel(
  member: TeamMember,
  currentUserId: string | null = null,
): string {
  const primary = teamMemberPrimaryLabel(member, currentUserId);
  if (member.displayName && member.email) return `${primary} — ${member.email}`;
  if (!member.displayName && member.email) return `${primary} — name not set`;
  return primary;
}

/** Secondary text for custom menus. */
export function teamMemberSecondaryLabel(member: TeamMember): string | null {
  if (member.displayName && member.email) return member.email;
  if (!member.displayName) return "Name not set";
  return null;
}

export function sortTeamMembers(members: TeamMember[]): TeamMember[] {
  return [...members].sort((a, b) => {
    const aActive = a.isActive !== false;
    const bActive = b.isActive !== false;
    if (aActive !== bActive) return aActive ? -1 : 1;
    return teamMemberPrimaryLabel(a).localeCompare(teamMemberPrimaryLabel(b));
  });
}
