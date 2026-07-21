import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isEmailAllowed } from "@/lib/auth/allowlist";

export function isPublicPath(path: string): boolean {
  return (
    path.startsWith("/login") ||
    path.startsWith("/auth") ||
    path.startsWith("/brand") ||
    path.startsWith("/api/webhooks") ||
    path.startsWith("/api/oauth") ||
    path.startsWith("/api/cron") ||
    path.startsWith("/api/internal/jitter") ||
    path.startsWith("/api/internal/closer/practice-outcomes/") ||
    path.startsWith("/api/internal/bmh-institute/course-outcomes/")
  );
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
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
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("error", "domain");
    return NextResponse.redirect(url);
  }

  // Callback cleanup is best-effort: auth-js can return an API error before
  // removing its local session cookies. Re-authorize every protected request
  // against Sandra's own membership table so a surviving BMH-domain Auth
  // cookie can never become application access.
  if (user && !isPublic) {
    let hasMembership = false;
    try {
      const { data, error } = await supabase
        .from("memberships")
        .select("user_id")
        .eq("user_id", user.id)
        .limit(1);
      hasMembership = !error && Boolean(data?.length);
    } catch {
      hasMembership = false;
    }

    if (!hasMembership) {
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        // The membership gate still denies this request if cleanup fails.
      }
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = "";
      url.searchParams.set("error", "access");
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}
