import { NextResponse, type NextRequest } from "next/server";

import { startHugoSignIn } from "@/lib/auth/start-hugo";

/** Stable launch URL used by Hugo's Sandra card and the direct login page. */
export async function GET(request: NextRequest) {
  const result = await startHugoSignIn(
    request.nextUrl.origin,
    request.nextUrl.searchParams.get("next"),
  );
  if (result.ok) {
    return NextResponse.redirect(result.authUrl);
  }

  const login = new URL("/login", request.nextUrl.origin);
  login.searchParams.set(
    "error",
    result.reason === "disabled" ? "sso_disabled" : "sso",
  );
  if (result.next) login.searchParams.set("next", result.next);
  return NextResponse.redirect(login);
}
