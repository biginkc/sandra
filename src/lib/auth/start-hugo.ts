import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";

import { sanitizeNextPath } from "@/lib/auth/safe-next";
import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";

export type HugoStartResult =
  | { ok: true; authUrl: string }
  | {
      ok: false;
      next: string;
      reason: "disabled" | "in_progress" | "unavailable";
    };

export const HUGO_FLOW_COOKIE = "sandra_hugo_flow";
export const HUGO_FLOW_QUERY = "hugo_flow";
export const HUGO_FLOW_COOKIE_PATH = "/";
export const HUGO_FLOW_SOURCE_QUERY = "hugo_source";

export function hugoFlowCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: HUGO_FLOW_COOKIE_PATH,
    maxAge: 10 * 60,
  };
}

/** Build a Hugo authorization request for either the login action or /auth/hugo. */
export async function startHugoSignIn(
  origin: string,
  rawNext: unknown,
): Promise<HugoStartResult> {
  const next = sanitizeNextPath(rawNext);
  if (process.env.NEXT_PUBLIC_HUGO_SSO !== "1") {
    return { ok: false, next, reason: "disabled" };
  }

  try {
    const cookieStore = await cookies();
    if (cookieStore.get(HUGO_FLOW_COOKIE)?.value) {
      // Supabase stores one PKCE verifier per project. Refuse a second launch
      // instead of overwriting the first tab's verifier and nonce.
      return { ok: false, next, reason: "in_progress" };
    }
    const flowNonce = randomBytes(32).toString("base64url");
    const redirectTo = new URL(
      "/auth/callback",
      `${origin.replace(/\/$/, "")}/`,
    );
    redirectTo.searchParams.set(HUGO_FLOW_QUERY, flowNonce);
    redirectTo.searchParams.set(HUGO_FLOW_SOURCE_QUERY, "hugo");
    if (next) redirectTo.searchParams.set("next", next);
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "custom:hugo",
      options: { redirectTo: redirectTo.toString() },
    });

    if (error || !data.url) {
      if (error) {
        reportError(new Error(error.message), {
          tags: { surface: "hugo_sso" },
        });
      }
      return { ok: false, next, reason: "unavailable" };
    }
    cookieStore.set(HUGO_FLOW_COOKIE, flowNonce, hugoFlowCookieOptions());
    return { ok: true, authUrl: data.url };
  } catch (error) {
    reportError(error, { tags: { surface: "hugo_sso" } });
    return { ok: false, next, reason: "unavailable" };
  }
}
