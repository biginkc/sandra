import { type NextRequest, type NextResponse } from "next/server";

function supabaseAuthCookieBase(): string | null {
  try {
    const [projectRef] = new URL(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    ).hostname.split(".");
    return projectRef && /^[a-z0-9]+$/.test(projectRef)
      ? `sb-${projectRef}-auth-token`
      : null;
  } catch {
    return null;
  }
}

function isSupabaseAuthCookie(name: string, base: string): boolean {
  if (!name.startsWith(base)) return false;
  return /^(?:-(?:code-verifier|user))?(?:\.(?:0|[1-9]\d*))?$/.test(
    name.slice(base.length),
  );
}

function isSupabasePkceCookie(name: string, base: string): boolean {
  if (!name.startsWith(`${base}-code-verifier`)) return false;
  return /^(?:\.(?:0|[1-9]\d*))?$/.test(
    name.slice(`${base}-code-verifier`.length),
  );
}

function expireCookies(
  request: NextRequest,
  response: NextResponse,
  writtenCookieNames: ReadonlySet<string>,
  matches: (name: string, base: string) => boolean,
): NextResponse {
  const base = supabaseAuthCookieBase();
  if (!base) return response;

  const names = new Set([
    base,
    `${base}-code-verifier`,
    `${base}-user`,
    ...request.cookies.getAll().map(({ name }) => name),
    ...response.cookies.getAll().map(({ name }) => name),
    ...writtenCookieNames,
  ]);
  for (const name of names) {
    if (!matches(name, base)) continue;
    response.cookies.set(name, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      expires: new Date(0),
      maxAge: 0,
    });
  }
  return response;
}

export function expireSupabasePkceCookies(
  request: NextRequest,
  response: NextResponse,
  writtenCookieNames: ReadonlySet<string> = new Set(),
): NextResponse {
  return expireCookies(
    request,
    response,
    writtenCookieNames,
    isSupabasePkceCookie,
  );
}

export function expireSupabaseAuthCookies(
  request: NextRequest,
  response: NextResponse,
  writtenCookieNames: ReadonlySet<string> = new Set(),
): NextResponse {
  return expireCookies(
    request,
    response,
    writtenCookieNames,
    isSupabaseAuthCookie,
  );
}
