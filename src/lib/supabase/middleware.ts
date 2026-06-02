import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isEmailAllowed } from "@/lib/auth/allowlist";

export function isPublicPath(path: string): boolean {
  return (
    path.startsWith("/login") ||
    path.startsWith("/auth") ||
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
    await supabase.auth.signOut();
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("error", "domain");
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
