import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isEmailAllowed } from "@/lib/auth/allowlist";
import {
  hasActiveSandraAccess,
  isMissingHugoAccessColumnError,
} from "@/lib/auth/access-state";
import { hasCurrentHugoOAuthProof } from "@/lib/auth/hugo-proof";
import { SANDRA_ORG_ID } from "@/lib/auth/sandra-org";
import { expireSupabaseAuthCookies } from "@/lib/auth/supabase-cookies";

export function isPublicPath(path: string): boolean {
  return (
    path.startsWith("/login") ||
    path.startsWith("/auth") ||
    path.startsWith("/brand") ||
    path.startsWith("/api/webhooks") ||
    path.startsWith("/api/cron") ||
    path.startsWith("/api/internal/jitter") ||
    path.startsWith("/api/internal/closer/practice-outcomes/") ||
    path.startsWith("/api/internal/bmh-institute/course-outcomes/")
  );
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  const writtenCookieNames = new Set<string>();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name }) => writtenCookieNames.add(name));
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = isPublicPath(path);
  const allowLocalE2ePasswordSession =
    process.env.NODE_ENV !== "production" &&
    process.env.E2E_AUTH_BYPASS === "1";
  const hugoRequired = process.env.NEXT_PUBLIC_HUGO_SSO === "1";

  const denyAndClear = (error: "access" | "domain" | "password_disabled") => {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("error", error);
    return expireSupabaseAuthCookies(
      request,
      NextResponse.redirect(url),
      writtenCookieNames,
    );
  };

  if (!user && !isPublic) {
    // Preserve the original path + query so the login flow can bounce the
    // user back to it after sign-in. Lets a teammate share /leads/<uuid>
    // links by email even when the recipient isn't already authed.
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path + request.nextUrl.search);
    return NextResponse.redirect(url);
  }

  // Domain allowlist — if someone's authenticated but not on the
  // @bmhgroupkc.com domain (or explicitly allowlisted), sign them out
  // and bounce to /login with an error. Skips public paths so the
  // /login error banner itself is reachable + /auth/* flows can
  // complete before we enforce.
  if (user && !isPublic && !isEmailAllowed(user.email)) {
    try {
      await supabase.auth.signOut();
    } catch {
      // Access is denied by the redirect even if Auth cookie cleanup fails.
    }
    return denyAndClear("domain");
  }

  // Password UI removal is not an authorization boundary. Re-check the
  // current session's provider proof on every protected request so a legacy
  // password session or a different OAuth identity cannot enter Sandra.
  if (user && !isPublic && hugoRequired && !allowLocalE2ePasswordSession) {
    let hasHugoProof = false;
    try {
      const { data, error } = await supabase.auth.getClaims();
      hasHugoProof =
        !error &&
        hasCurrentHugoOAuthProof(data?.claims.amr, user.identities);
    } catch {
      hasHugoProof = false;
    }
    if (!hasHugoProof) {
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        // Explicit cookie expiry below remains the fail-closed boundary.
      }
      return denyAndClear("password_disabled");
    }
  }

  // Callback cleanup is best-effort: auth-js can return an API error before
  // removing its local session cookies. Re-authorize every protected request
  // against Sandra's own membership table so a surviving BMH-domain Auth
  // cookie can never become application access.
  if (user && !isPublic) {
    let hasMembership = false;
    try {
      if (!hugoRequired) {
        const legacy = await supabase
          .from("memberships")
          .select("user_id")
          .eq("user_id", user.id)
          .eq("org_id", SANDRA_ORG_ID)
          .limit(1);
        hasMembership = !legacy.error && Boolean(legacy.data?.length);
      } else {
        const membershipQuery = supabase
          .from("memberships")
          .select("user_id, access_status, access_expires_at, deletion_prepared_at")
          .eq("user_id", user.id)
          .eq("org_id", SANDRA_ORG_ID);
        const { data, error } = await membershipQuery.limit(1);
        const membership = data?.[0] as
          | {
              access_status?: string | null;
              access_expires_at?: string | null;
              deletion_prepared_at?: string | null;
          }
          | undefined;
        if (!error) {
          hasMembership = hasActiveSandraAccess(membership);
        } else if (
          allowLocalE2ePasswordSession &&
          isMissingHugoAccessColumnError(error)
        ) {
          // The shared E2E project is intentionally migrated after merge, while
          // pull-request runs execute against the previous schema. Keep this
          // compatibility path local to the password-session test bypass; a
          // production schema mismatch remains fail-closed above.
          const legacy = await supabase
            .from("memberships")
            .select("user_id")
            .eq("user_id", user.id)
            .eq("org_id", SANDRA_ORG_ID)
            .limit(1);
          hasMembership = !legacy.error && Boolean(legacy.data?.length);
        }
      }
    } catch {
      hasMembership = false;
    }

    if (!hasMembership) {
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        // The membership gate still denies this request if cleanup fails.
      }
      return denyAndClear("access");
    }
  }

  return supabaseResponse;
}
