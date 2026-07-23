import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { isEmailAllowed } from "@/lib/auth/allowlist";
import { hasCurrentHugoOAuthProof } from "@/lib/auth/hugo-proof";
import { applyAuthNoCache } from "@/lib/auth/response";
import { sanitizeNextPath } from "@/lib/auth/safe-next";
import {
  HUGO_FLOW_COOKIE,
  HUGO_FLOW_COOKIE_PATH,
  HUGO_FLOW_QUERY,
  HUGO_FLOW_SOURCE_QUERY,
  hugoFlowCookieOptions,
} from "@/lib/auth/start-hugo";
import {
  expireSupabaseAuthCookies,
  expireSupabasePkceCookies,
} from "@/lib/auth/supabase-cookies";
import { createClient } from "@/lib/supabase/server";

const EMAIL_FLOW_TYPES = new Set([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

function flowNonceMatches(request: NextRequest): boolean {
  const queryNonce = request.nextUrl.searchParams.get(HUGO_FLOW_QUERY);
  const cookieNonce = request.cookies.get(HUGO_FLOW_COOKIE)?.value;
  if (!queryNonce || !cookieNonce) return false;
  const query = Buffer.from(queryNonce);
  const cookie = Buffer.from(cookieNonce);
  return query.length === cookie.length && timingSafeEqual(query, cookie);
}

function authRedirect(
  request: NextRequest,
  location: string,
  options: {
    consumeFlow: boolean;
    expirePkce: boolean;
    writtenCookieNames?: ReadonlySet<string>;
  },
) {
  const response = NextResponse.redirect(
    new URL(location, request.nextUrl.origin),
  );
  if (options.consumeFlow) {
    response.cookies.set(HUGO_FLOW_COOKIE, "", {
      ...hugoFlowCookieOptions(),
      path: HUGO_FLOW_COOKIE_PATH,
      maxAge: 0,
      expires: new Date(0),
    });
  }
  if (options.expirePkce) {
    expireSupabasePkceCookies(
      request,
      response,
      options.writtenCookieNames,
    );
  }
  return applyAuthNoCache(response);
}

async function rejectExchangedSession(
  request: NextRequest,
  supabase: Awaited<ReturnType<typeof createClient>>,
  location: string,
  writtenCookieNames: ReadonlySet<string>,
) {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // Explicit project-scoped expiry below is the fail-closed boundary.
  }
  const response = authRedirect(request, location, {
    consumeFlow: true,
    expirePkce: true,
    writtenCookieNames,
  });
  return expireSupabaseAuthCookies(request, response, writtenCookieNames);
}

/** Complete only a live, marked Hugo OIDC/PKCE exchange. */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const type = searchParams.get("type")?.toLowerCase();
  const tokenHash = searchParams.get("token_hash");
  const cookieNonce = request.cookies.get(HUGO_FLOW_COOKIE)?.value;
  const validFlow = flowNonceMatches(request);
  const markedHugoFlow =
    searchParams.get(HUGO_FLOW_SOURCE_QUERY) === "hugo";

  // Do not let an unrelated stale link destroy a different tab's active Hugo
  // flow. Only the callback carrying the matching nonce may consume it.
  const rejectUnmarked = (location: string) =>
    authRedirect(request, location, {
      consumeFlow: validFlow,
      expirePkce: validFlow || !cookieNonce,
    });

  if (tokenHash || (type && EMAIL_FLOW_TYPES.has(type))) {
    return rejectUnmarked("/login?error=password_disabled");
  }
  if (
    process.env.NEXT_PUBLIC_HUGO_SSO !== "1" ||
    !markedHugoFlow ||
    !validFlow
  ) {
    return rejectUnmarked(
      process.env.NEXT_PUBLIC_HUGO_SSO === "1"
        ? "/login?error=sso"
        : "/login?error=sso_disabled",
    );
  }
  if (!code) {
    return authRedirect(request, "/login?error=sso", {
      consumeFlow: true,
      expirePkce: true,
    });
  }

  const writtenCookieNames = new Set<string>();
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient({
      onCookieMutation: ({ name }) => writtenCookieNames.add(name),
    });
  } catch {
    return authRedirect(request, "/login?error=sso", {
      consumeFlow: true,
      expirePkce: true,
    });
  }

  let exchange: Awaited<
    ReturnType<typeof supabase.auth.exchangeCodeForSession>
  >;
  try {
    exchange = await supabase.auth.exchangeCodeForSession(code);
  } catch {
    return rejectExchangedSession(
      request,
      supabase,
      "/login?error=sso",
      writtenCookieNames,
    );
  }

  try {
    const { error, data } = exchange;
    if (error || !data.session) {
      return rejectExchangedSession(
        request,
        supabase,
        "/login?error=sso",
        writtenCookieNames,
      );
    }

    const { data: claimsData, error: claimsError } =
      await supabase.auth.getClaims(data.session.access_token);
    if (
      claimsError ||
      !hasCurrentHugoOAuthProof(
        claimsData?.claims.amr,
        data.session.user.identities,
      )
    ) {
      return rejectExchangedSession(
        request,
        supabase,
        "/login?error=password_disabled",
        writtenCookieNames,
      );
    }

    if (!isEmailAllowed(data.session.user.email)) {
      return rejectExchangedSession(
        request,
        supabase,
        "/login?error=domain",
        writtenCookieNames,
      );
    }

    const { data: memberships, error: membershipError } = await supabase
      .from("memberships")
      .select("user_id")
      .eq("user_id", data.session.user.id)
      .limit(1);
    if (membershipError || !memberships?.length) {
      return rejectExchangedSession(
        request,
        supabase,
        "/login?error=access",
        writtenCookieNames,
      );
    }

    const target = sanitizeNextPath(searchParams.get("next"), "/dashboard");
    return authRedirect(request, target, {
      consumeFlow: true,
      expirePkce: true,
      writtenCookieNames,
    });
  } catch {
    return rejectExchangedSession(
      request,
      supabase,
      "/login?error=access",
      writtenCookieNames,
    );
  }
}
