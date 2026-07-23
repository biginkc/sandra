"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { sanitizeNextPath } from "@/lib/auth/safe-next";
import { startHugoSignIn } from "@/lib/auth/start-hugo";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";

function firstForwarded(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/**
 * Start Sandra's only end-user authentication flow.
 *
 * The public feature flag remains a server-enforced rollout gate: deploying
 * this code before the provider is configured cannot accidentally start an
 * incomplete OIDC flow. Password and recovery actions deliberately do not
 * exist in this module.
 */
export async function signInWithHugo(
  _prevState: void,
  formData: FormData,
): Promise<void> {
  const h = await headers();
  const proto = firstForwarded(h.get("x-forwarded-proto")) ?? "https";
  const host = firstForwarded(h.get("x-forwarded-host")) ?? h.get("host");
  const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const origin = host
    ? `${proto}://${host}`
    : configuredOrigin?.replace(/\/$/, "") || "https://sandra.bmhgroupkc.com";
  const result = await startHugoSignIn(origin, formData.get("next"));

  if (!result.ok) {
    if (result.reason === "disabled") {
      redirect("/login?error=sso_disabled");
    }
    if (result.reason === "in_progress") {
      redirect(
        result.next
          ? `/login?error=sso_in_progress&next=${encodeURIComponent(result.next)}`
          : "/login?error=sso_in_progress",
      );
    }
    redirect(
      result.next
        ? `/login?error=sso&next=${encodeURIComponent(result.next)}`
        : "/login?error=sso",
    );
  }
  redirect(result.authUrl);
}

/**
 * Rollback path only. The password form is rendered only while Hugo is off,
 * and this action independently enforces the same gate so it cannot be called
 * directly after the cutover.
 */
export async function signIn(
  _prevState: Result<null> | null,
  formData: FormData,
): Promise<Result<null>> {
  if (process.env.NEXT_PUBLIC_HUGO_SSO === "1") {
    return {
      ok: false,
      error: {
        code: "PASSWORD_DISABLED",
        message: "Sandra passwords are disabled. Continue with Hugo.",
      },
    };
  }

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = sanitizeNextPath(formData.get("next"), "/dashboard");
  if (!email || !password) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Email and password are required.",
      },
    };
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      return {
        ok: false,
        error: { code: "AUTH_FAILED", message: error.message },
      };
    }
  } catch (error) {
    reportError(error, { tags: { surface: "login_action" } });
    return errFromUnknown(error, "AUTH_FAILED");
  }

  redirect(next);
  return ok(null);
}

/** Emergency rollback recovery only; Hugo owns recovery after cutover. */
export async function requestPasswordReset(
  _prevState: Result<null> | null,
  formData: FormData,
): Promise<Result<null>> {
  if (process.env.NEXT_PUBLIC_HUGO_SSO === "1") {
    return {
      ok: false,
      error: {
        code: "PASSWORD_DISABLED",
        message: "Sandra password recovery is disabled. Continue with Hugo.",
      },
    };
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Email is required." },
    };
  }

  try {
    const h = await headers();
    const proto = firstForwarded(h.get("x-forwarded-proto")) ?? "https";
    const host = firstForwarded(h.get("x-forwarded-host")) ?? h.get("host");
    const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim();
    const origin = host
      ? `${proto}://${host}`
      : configuredOrigin?.replace(/\/$/, "") ||
        "https://sandra.bmhgroupkc.com";
    const supabase = await createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${origin}/auth/callback`,
    });
    if (error) {
      reportError(new Error(error.message), {
        tags: { surface: "request_password_reset" },
      });
    }
  } catch (error) {
    reportError(error, { tags: { surface: "request_password_reset" } });
  }

  // Do not reveal whether an Auth user exists for the submitted email.
  return ok(null);
}
