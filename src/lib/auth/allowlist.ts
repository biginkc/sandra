/**
 * Access control — who's allowed into the CRM at all.
 *
 * Rule: the authenticated user's email must end in `@bmhgroupkc.com`
 * (the BMH Group Google Workspace domain).
 *
 * Enforced in middleware on every request — a Hugo-authenticated user with a
 * non-allowed email gets signed out and bounced to `/login?error=domain`.
 * Supabase also has sign-up disabled, so Hugo can link only to an existing
 * Sandra auth user that an admin provisioned deliberately.
 */

export const ALLOWED_DOMAIN = "bmhgroupkc.com";

export function isEmailAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  return lower.endsWith(`@${ALLOWED_DOMAIN}`);
}

/**
 * Is this email an admin? Admins can invite new users and see the
 * `/admin/*` pages. Comma-separated env var so we can add people
 * without a code change.
 *
 *   ADMIN_EMAILS=admin-one@bmhgroupkc.com,admin-two@bmhgroupkc.com
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.ADMIN_EMAILS ?? "";
  const admins = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.toLowerCase());
}
