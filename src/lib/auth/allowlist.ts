/**
 * Access control — who's allowed into the CRM at all.
 *
 * Rule: the authenticated user's email must end in `@bmhgroupkc.com`
 * (the BMH Group Google Workspace domain). One dev-user exception is
 * allowed so the test account doesn't need to be provisioned inside
 * Workspace.
 *
 * Enforced in middleware on every request — a user who's somehow
 * authenticated with a non-allowed email gets signed out and bounced
 * to `/login?error=domain`. Supabase-level password auth is still the
 * only sign-in method, so this is primarily defense-in-depth against
 * future OAuth providers, not the first line of access control.
 */

export const ALLOWED_DOMAIN = "bmhgroupkc.com";

/** Explicit one-off users allowed outside the domain check. */
const EMAIL_ALLOWLIST: ReadonlySet<string> = new Set([
  // Dev / Claude's smoke-test user. Remove when we migrate dev login to
  // a real @bmhgroupkc.com account.
  "claude@test.com",
]);

export function isEmailAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  if (EMAIL_ALLOWLIST.has(lower)) return true;
  return lower.endsWith(`@${ALLOWED_DOMAIN}`);
}

/**
 * Is this email an admin? Admins can invite new users and see the
 * `/admin/*` pages. Comma-separated env var so we can add people
 * without a code change.
 *
 *   ADMIN_EMAILS=jarrad@bmhgroupkc.com,someone-else@bmhgroupkc.com
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.ADMIN_EMAILS ?? "jarrad@bmhgroupkc.com";
  const admins = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.toLowerCase());
}
