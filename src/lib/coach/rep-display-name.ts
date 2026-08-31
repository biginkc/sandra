import type { User } from "@supabase/supabase-js";

const KNOWN_REP_NAMES_BY_EMAIL = new Map<string, string>([
  ["jarrad@bmhgroupkc.com", "Jarrad Henry"],
]);

function repNameFallbackFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const localPart = email.split("@")[0];
  if (!localPart) return null;
  const parts = localPart.split(/[._+-]+/).filter(Boolean);
  if (parts.length < 2) return null;
  return parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ") || null;
}

/** Resolves the trusted display name available on the authenticated user. */
export function repDisplayName(
  user: Pick<User, "email" | "user_metadata"> | null | undefined,
): string | null {
  const stored = user?.user_metadata?.display_name;
  if (typeof stored === "string" && stored.trim()) return stored.trim();
  const known = user?.email ? KNOWN_REP_NAMES_BY_EMAIL.get(user.email.trim().toLowerCase()) : null;
  if (known) return known;
  return repNameFallbackFromEmail(user?.email);
}

/** Resolves the trusted complete identity used to derive file-number initials. */
export function repFileNumberIdentity(
  user: Pick<User, "email" | "user_metadata"> | null | undefined,
): string | null {
  const known = user?.email ? KNOWN_REP_NAMES_BY_EMAIL.get(user.email.trim().toLowerCase()) : null;
  return known ?? repDisplayName(user);
}
