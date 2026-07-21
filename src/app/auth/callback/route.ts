import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { isEmailAllowed } from "@/lib/auth/allowlist";
import { sanitizeNextPath } from "@/lib/auth/safe-next";

const EMAIL_OTP_TYPES = new Set<string>([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

/**
 * Supabase OAuth / invite / magic-link callback. Exchanges the one-time
 * `code` param from the email link for a durable session cookie, then
 * redirects the user onward.
 *
 * Invite flow: the user opens their "You've been invited to Sandra CRM"
 * email → clicks the link → lands here with `?code=...&type=invite`
 * → we exchange for a session → redirect to `/auth/set-password` so
 * they can set a password before anything else.
 *
 * Future OAuth (Google/Apple/etc.) will land here with `type=oauth`
 * and we'll route to `/leads` (or the `next` param).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const type = searchParams.get("type");
  const tokenHash = searchParams.get("token_hash");
  const next = searchParams.get("next");

  if (tokenHash && type && EMAIL_OTP_TYPES.has(type)) {
    const supabase = await createClient();
    const { error, data } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as EmailOtpType,
    });
    if (error || !data.session) {
      return NextResponse.redirect(`${origin}/login?error=invite_failed`);
    }

    const email = data.session.user.email;
    if (!isEmailAllowed(email)) {
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/login?error=domain`);
    }

    if (type === "invite" || type === "recovery" || type === "signup") {
      return NextResponse.redirect(`${origin}/auth/set-password`);
    }

    const target = sanitizeNextPath(next, "/dashboard");
    return NextResponse.redirect(`${origin}${target}`);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=invite_failed`);
  }

  const supabase = await createClient();
  const { error, data } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session) {
    return NextResponse.redirect(`${origin}/login?error=invite_failed`);
  }

  // Domain allowlist — if Supabase somehow authed a non-allowed email
  // (e.g. a stale invite for a user whose domain changed), sign out
  // immediately so they can't proceed.
  const email = data.session.user.email;
  if (!isEmailAllowed(email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=domain`);
  }

  // Invite / recovery / first-time flows route to set-password so the
  // new team member can pick their credentials before landing in the app.
  if (type === "invite" || type === "recovery" || type === "signup") {
    return NextResponse.redirect(`${origin}/auth/set-password`);
  }

  const target = sanitizeNextPath(next, "/dashboard");
  return NextResponse.redirect(`${origin}${target}`);
}
