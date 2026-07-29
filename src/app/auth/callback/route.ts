import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { isEmailAllowed } from "@/lib/auth/allowlist";
import { hasActiveSandraAccess } from "@/lib/auth/access-state";
import { hasCurrentHugoOAuthProof } from "@/lib/auth/hugo-proof";
import { applyAuthNoCache } from "@/lib/auth/response";
import { sanitizeNextPath } from "@/lib/auth/safe-next";
import { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";
import {
  HUGO_FLOW_COOKIE_PATH,
  HUGO_FLOW_QUERY,
  HUGO_FLOW_SOURCE_QUERY,
  decodeHugoPkceState,
  hugoFlowCookieName,
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
const PASSWORD_SETUP_METHODS = new Set(["signup", "invite", "recovery"]);

function rollbackRedirect(request: NextRequest, location: string) {
  return applyAuthNoCache(
    NextResponse.redirect(new URL(location, request.nextUrl.origin)),
  );
}

async function completeRollbackEmailFlow(
  request: NextRequest,
  code: string | null,
  tokenHash: string | null,
  type: string | null,
) {
  if (!code && !(tokenHash && type && EMAIL_FLOW_TYPES.has(type))) {
    return rollbackRedirect(request, "/login?error=invite_failed");
  }

  try {
    const supabase = await createClient();
    const result = tokenHash && type && EMAIL_FLOW_TYPES.has(type)
      ? await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: type as EmailOtpType,
        })
      : await supabase.auth.exchangeCodeForSession(code!);
    if (result.error || !result.data.session) {
      return rollbackRedirect(request, "/login?error=invite_failed");
    }

    if (!isEmailAllowed(result.data.session.user.email)) {
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        // The callback still denies navigation if cleanup fails.
      }
      return rollbackRedirect(request, "/login?error=domain");
    }

    let passwordSetup = Boolean(type && PASSWORD_SETUP_METHODS.has(type));
    if (!type) {
      const { data } = await supabase.auth.getClaims(
        result.data.session.access_token,
      );
      const methods = Array.isArray(data?.claims.amr) ? data.claims.amr : [];
      passwordSetup = methods.some((entry) => {
        const method =
          typeof entry === "string"
            ? entry
            : entry && typeof entry === "object" && "method" in entry
              ? entry.method
              : null;
        return typeof method === "string" && PASSWORD_SETUP_METHODS.has(method);
      });
    }

    const target = passwordSetup
      ? "/auth/set-password"
      : sanitizeNextPath(request.nextUrl.searchParams.get("next"), "/dashboard");
    return rollbackRedirect(request, target);
  } catch {
    return rollbackRedirect(request, "/login?error=invite_failed");
  }
}

function flowNonceMatches(request: NextRequest): boolean {
  const queryNonce = request.nextUrl.searchParams.get(HUGO_FLOW_QUERY);
  const cookieName = queryNonce ? hugoFlowCookieName(queryNonce) : null;
  const state = cookieName ? request.cookies.get(cookieName)?.value : null;
  if (!queryNonce || !state || decodeHugoPkceState(state).length === 0) {
    return false;
  }
  // The cookie name is derived from the nonce and the cookie value is
  // httpOnly, so a matching cookie lookup is the binding. Comparing the
  // nonce to the suffix of its own derived name would be tautological.
  return true;
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
    const queryNonce = request.nextUrl.searchParams.get(HUGO_FLOW_QUERY);
    const cookieName = queryNonce ? hugoFlowCookieName(queryNonce) : null;
    if (cookieName) {
      response.cookies.set(cookieName, "", {
        ...hugoFlowCookieOptions(),
        path: HUGO_FLOW_COOKIE_PATH,
        maxAge: 0,
        expires: new Date(0),
      });
    }
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
  const validFlow = flowNonceMatches(request);
  const markedHugoFlow =
    searchParams.get(HUGO_FLOW_SOURCE_QUERY) === "hugo";

  if (process.env.NEXT_PUBLIC_HUGO_SSO !== "1" && !markedHugoFlow) {
    return completeRollbackEmailFlow(request, code, tokenHash, type ?? null);
  }

  // Do not let an unrelated stale link destroy a different tab's active Hugo
  // flow. Only the callback carrying the matching nonce may consume it.
  const rejectUnmarked = (location: string) =>
    authRedirect(request, location, {
      consumeFlow: validFlow,
      expirePkce: validFlow,
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
    const queryNonce = searchParams.get(HUGO_FLOW_QUERY)!;
    const flowCookieName = hugoFlowCookieName(queryNonce)!;
    const cookieOverrides = decodeHugoPkceState(
      request.cookies.get(flowCookieName)!.value,
    );
    supabase = await createClient({
      onCookieMutation: ({ name }) => writtenCookieNames.add(name),
      cookieOverrides,
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
      .select("user_id, access_status, access_expires_at, deletion_prepared_at")
      .eq("user_id", data.session.user.id)
      .eq("org_id", SANDRA_ORG_ID)
      .limit(1);
    const membership = memberships?.[0] as
      | {
          access_status?: string | null;
          access_expires_at?: string | null;
          deletion_prepared_at?: string | null;
        }
      | undefined;
    if (membershipError || !hasActiveSandraAccess(membership)) {
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
