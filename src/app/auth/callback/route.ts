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
const HUGO_PROVIDER = "custom:hugo";
const MAX_IDENTITY_AMR_SKEW_SECONDS = 5;

function isCurrentHugoIdentity(amr: unknown, identities: unknown): boolean {
  if (!Array.isArray(amr) || !Array.isArray(identities)) return false;
  const oauthMethods = new Set(["oauth", "oauth_provider/authorization_code"]);
  const oauthTimestamps = amr.flatMap((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("method" in entry) ||
      !("timestamp" in entry) ||
      typeof entry.method !== "string" ||
      !oauthMethods.has(entry.method) ||
      typeof entry.timestamp !== "number" ||
      !Number.isFinite(entry.timestamp)
    ) {
      return [];
    }
    return [entry.timestamp];
  });

  return oauthTimestamps.some((oauthTimestamp) => {
    const currentIdentities = identities.filter((identity) => {
      if (
        typeof identity !== "object" ||
        identity === null ||
        !("last_sign_in_at" in identity) ||
        typeof identity.last_sign_in_at !== "string"
      ) {
        return false;
      }
      const identityTimestamp = Date.parse(identity.last_sign_in_at) / 1000;
      return (
        Number.isFinite(identityTimestamp) &&
        Math.abs(identityTimestamp - oauthTimestamp) <=
          MAX_IDENTITY_AMR_SKEW_SECONDS
      );
    });

    // Fail closed if multiple linked identities appear current. This proves
    // that the OAuth method in the signed JWT belongs to Hugo specifically,
    // not merely that the user has linked Hugo at some point in the past.
    return (
      currentIdentities.length === 1 &&
      "provider" in currentIdentities[0] &&
      currentIdentities[0].provider === HUGO_PROVIDER
    );
  });
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
    !isCurrentHugoIdentity(
      claimsData?.claims.amr,
      data.session.user.identities,
    )
  ) {
    await supabase.auth.signOut({ scope: "local" });
    return NextResponse.redirect(`${origin}/login?error=password_disabled`);
  }

  if (!isEmailAllowed(data.session.user.email)) {
    await supabase.auth.signOut({ scope: "local" });
    return NextResponse.redirect(`${origin}/login?error=domain`);
  }

  const { data: memberships, error: membershipError } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("user_id", data.session.user.id)
    .limit(1);
  if (membershipError || !memberships?.length) {
    await supabase.auth.signOut({ scope: "local" });
    return NextResponse.redirect(`${origin}/login?error=access`);
  }

  const target = sanitizeNextPath(searchParams.get("next"), "/dashboard");
  return NextResponse.redirect(`${origin}${target}`);
}
