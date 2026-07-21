import { NextResponse, type NextRequest } from "next/server";

import { isEmailAllowed } from "@/lib/auth/allowlist";
import { sanitizeNextPath } from "@/lib/auth/safe-next";
import { createClient } from "@/lib/supabase/server";

const EMAIL_FLOW_TYPES = new Set([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

function isOAuthAuthenticationMethod(amr: unknown): boolean {
  if (!Array.isArray(amr)) return false;
  const oauthMethods = new Set(["oauth", "oauth_provider/authorization_code"]);
  return amr.some(
    (entry) =>
      (typeof entry === "string" && oauthMethods.has(entry)) ||
      (typeof entry === "object" &&
        entry !== null &&
        "method" in entry &&
        typeof entry.method === "string" &&
        oauthMethods.has(entry.method)),
  );
}

/**
 * Complete only Hugo's OIDC/PKCE code exchange.
 *
 * Historical invite, recovery, signup, and magic-link callbacks are rejected
 * before token verification or code exchange so those links cannot establish
 * a Sandra session even while an old email is still in someone's inbox.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const type = searchParams.get("type")?.toLowerCase();
  const tokenHash = searchParams.get("token_hash");

  if (tokenHash || (type && EMAIL_FLOW_TYPES.has(type))) {
    return NextResponse.redirect(`${origin}/login?error=password_disabled`);
  }
  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=sso`);
  }

  const supabase = await createClient();
  const { error, data } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session) {
    return NextResponse.redirect(`${origin}/login?error=sso`);
  }

  // Email PKCE links can arrive with only `?code=...` and no `type` marker.
  // Verify the signed AMR claim instead of trusting callback parameters so a
  // stale magic, invite, or recovery link cannot create a Sandra session.
  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims(data.session.access_token);
  if (
    claimsError ||
    !isOAuthAuthenticationMethod(claimsData?.claims.amr)
  ) {
    await supabase.auth.signOut({ scope: "local" });
    return NextResponse.redirect(`${origin}/login?error=password_disabled`);
  }

  if (!isEmailAllowed(data.session.user.email)) {
    await supabase.auth.signOut({ scope: "local" });
    return NextResponse.redirect(`${origin}/login?error=domain`);
  }

  const target = sanitizeNextPath(searchParams.get("next"), "/dashboard");
  return NextResponse.redirect(`${origin}${target}`);
}
