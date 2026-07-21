import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { isEmailAllowed } from "@/lib/auth/allowlist";
import { sanitizeNextPath } from "@/lib/auth/safe-next";
import {
  HUGO_FLOW_COOKIE,
  HUGO_FLOW_COOKIE_PATH,
  HUGO_FLOW_QUERY,
  hugoFlowCookieOptions,
} from "@/lib/auth/start-hugo";
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

function hasHugoOAuthProof(amr: unknown, identities: unknown): boolean {
  if (!Array.isArray(amr) || !Array.isArray(identities)) return false;
  const oauthMethods = new Set(["oauth", "oauth_provider/authorization_code"]);
  const hasOAuthAmr = amr.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "method" in entry &&
      typeof entry.method === "string" &&
      oauthMethods.has(entry.method),
  );
  const hasHugoIdentity = identities.some(
    (identity) =>
      typeof identity === "object" &&
      identity !== null &&
      "provider" in identity &&
      identity.provider === HUGO_PROVIDER,
  );
  return hasOAuthAmr && hasHugoIdentity;
}

function flowNonceMatches(request: NextRequest): boolean {
  const queryNonce = request.nextUrl.searchParams.get(HUGO_FLOW_QUERY);
  const cookieNonce = request.cookies.get(HUGO_FLOW_COOKIE)?.value;
  if (!queryNonce || !cookieNonce) return false;
  const query = Buffer.from(queryNonce);
  const cookie = Buffer.from(cookieNonce);
  return query.length === cookie.length && timingSafeEqual(query, cookie);
}

function redirectAndConsumeFlow(request: NextRequest, location: string) {
  const response = NextResponse.redirect(
    new URL(location, request.nextUrl.origin),
  );
  response.cookies.set(HUGO_FLOW_COOKIE, "", {
    ...hugoFlowCookieOptions(),
    path: HUGO_FLOW_COOKIE_PATH,
    maxAge: 0,
  });
  return response;
}

async function signOutAndConsumeFlow(
  request: NextRequest,
  supabase: Awaited<ReturnType<typeof createClient>>,
  location: string,
) {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // Cookie cleanup below must still run if the Auth SDK itself throws.
  }
  return redirectAndConsumeFlow(request, location);
}

/**
 * Complete only Hugo's OIDC/PKCE code exchange.
 *
 * Historical invite, recovery, signup, and magic-link callbacks are rejected
 * before token verification or code exchange so those links cannot establish
 * a Sandra session even while an old email is still in someone's inbox.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const type = searchParams.get("type")?.toLowerCase();
  const tokenHash = searchParams.get("token_hash");

  if (tokenHash || (type && EMAIL_FLOW_TYPES.has(type))) {
    return redirectAndConsumeFlow(request, "/login?error=password_disabled");
  }
  if (!code || !flowNonceMatches(request)) {
    return redirectAndConsumeFlow(request, "/login?error=sso");
  }

  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch {
    return redirectAndConsumeFlow(request, "/login?error=sso");
  }
  let exchange: Awaited<
    ReturnType<typeof supabase.auth.exchangeCodeForSession>
  >;
  try {
    exchange = await supabase.auth.exchangeCodeForSession(code);
  } catch {
    return signOutAndConsumeFlow(request, supabase, "/login?error=sso");
  }
  const { error, data } = exchange;
  if (error || !data.session) {
    if (data.session) {
      return signOutAndConsumeFlow(request, supabase, "/login?error=sso");
    }
    return redirectAndConsumeFlow(request, "/login?error=sso");
  }

  try {
    // Email PKCE links can arrive with only `?code=...` and no `type` marker.
    // Verify the signed AMR claim instead of trusting callback parameters so a
    // stale magic, invite, or recovery link cannot create a Sandra session.
    const { data: claimsData, error: claimsError } =
      await supabase.auth.getClaims(data.session.access_token);
    if (
      claimsError ||
      !hasHugoOAuthProof(
        claimsData?.claims.amr,
        data.session.user.identities,
      )
    ) {
      return signOutAndConsumeFlow(
        request,
        supabase,
        "/login?error=password_disabled",
      );
    }

    if (!isEmailAllowed(data.session.user.email)) {
      return signOutAndConsumeFlow(request, supabase, "/login?error=domain");
    }

    const { data: memberships, error: membershipError } = await supabase
      .from("memberships")
      .select("user_id")
      .eq("user_id", data.session.user.id)
      .limit(1);
    if (membershipError || !memberships?.length) {
      return signOutAndConsumeFlow(request, supabase, "/login?error=access");
    }

    const target = sanitizeNextPath(searchParams.get("next"), "/dashboard");
    return redirectAndConsumeFlow(request, target);
  } catch {
    // The code exchange may already have written session cookies. Any
    // verification exception must therefore explicitly remove that session.
    return signOutAndConsumeFlow(request, supabase, "/login?error=access");
  }
}
