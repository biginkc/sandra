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

export const HUGO_FLOW_COOKIE = "sandra_hugo_flow_";
export const HUGO_FLOW_QUERY = "hugo_flow";
export const HUGO_FLOW_COOKIE_PATH = "/";
export const HUGO_FLOW_SOURCE_QUERY = "hugo_source";
const FLOW_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_COOKIE_PATTERN =
  /^sb-[a-z0-9]+-auth-token-code-verifier(?:\.(?:0|[1-9]\d*))?$/;

type StoredPkceCookie = { name: string; value: string };

export function hugoFlowCookieName(nonce: string): string | null {
  return FLOW_NONCE_PATTERN.test(nonce) ? `${HUGO_FLOW_COOKIE}${nonce}` : null;
}

export function decodeHugoPkceState(raw: string): StoredPkceCookie[] {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return [];
    return parsed.filter(
      (entry): entry is StoredPkceCookie =>
        Boolean(
          entry &&
            typeof entry === "object" &&
            "name" in entry &&
            typeof entry.name === "string" &&
            PKCE_COOKIE_PATTERN.test(entry.name) &&
            "value" in entry &&
            typeof entry.value === "string" &&
            entry.value.length > 0,
        ),
    );
  } catch {
    return [];
  }
}

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
    const flowNonce = randomBytes(32).toString("base64url");
    const flowCookieName = hugoFlowCookieName(flowNonce);
    if (!flowCookieName) {
      return { ok: false, next, reason: "unavailable" };
    }
    const redirectTo = new URL(
      "/auth/callback",
      `${origin.replace(/\/$/, "")}/`,
    );
    redirectTo.searchParams.set(HUGO_FLOW_QUERY, flowNonce);
    redirectTo.searchParams.set(HUGO_FLOW_SOURCE_QUERY, "hugo");
    if (next) redirectTo.searchParams.set("next", next);
    const cookieMutations: StoredPkceCookie[] = [];
    const supabase = await createClient({
      onCookieMutation: ({ name, value }) => {
        if (PKCE_COOKIE_PATTERN.test(name)) {
          cookieMutations.push({ name, value });
        }
      },
    });
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "custom:hugo",
      options: { redirectTo: redirectTo.toString() },
    });

    if (error || !data.url || cookieMutations.length === 0) {
      if (error) {
        reportError(new Error(error.message), {
          tags: { surface: "hugo_sso" },
        });
      }
      return { ok: false, next, reason: "unavailable" };
    }
    cookieStore.set(
      flowCookieName,
      Buffer.from(JSON.stringify(cookieMutations)).toString("base64url"),
      hugoFlowCookieOptions(),
    );
    return { ok: true, authUrl: data.url };
  } catch (error) {
    reportError(error, { tags: { surface: "hugo_sso" } });
    return { ok: false, next, reason: "unavailable" };
  }
}
