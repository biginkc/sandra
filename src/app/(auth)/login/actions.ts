"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { sanitizeNextPath } from "@/lib/auth/safe-next";
import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";

/**
 * Trigger Supabase's password-recovery email. The link in the email
 * carries a one-time PKCE code that lands at `/auth/callback?code=...`,
 * which exchanges it for a session and forwards the user to
 * `/auth/set-password` (existing infra). Returns success even when the
 * email isn't in the system, to avoid leaking which addresses exist.
 *
 * `redirectTo` is computed from the current request's host so it works
 * across prod, preview deploys, and local dev without a hard-coded URL.
 */
export async function requestPasswordReset(
  _prevState: Result<null> | null,
  formData: FormData,
): Promise<Result<null>> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Email is required." },
    };
  }

  try {
    const h = await headers();
    const proto = h.get("x-forwarded-proto") ?? "https";
    const host = h.get("host") ?? "sandra-sooty.vercel.app";
    const redirectTo = `${proto}://${host}/auth/callback`;

    const supabase = await createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });
    if (error) {
      // Surface the real error in dev/preview but never leak existence
      // info to a casual login attempt — the form always shows the
      // generic "check your inbox" success regardless.
      reportError(new Error(error.message), {
        tags: { surface: "request_password_reset" },
        extra: { email },
      });
    }
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "request_password_reset" } });
    // Same defense — even on a thrown error, return ok() so the UI
    // doesn't betray whether the address exists.
    return ok(null);
  }
}

/**
 * Start the Hugo single-sign-on flow. Sandra's own Supabase project is
 * configured (in the dashboard, at rollout time) with a Custom OIDC
 * provider named `custom:hugo` that points at the central bmh-auth IdP.
 * `signInWithOAuth` returns the IdP authorization URL and drops the PKCE
 * code-verifier cookie; we redirect the browser there, and the IdP sends
 * the user back to `/auth/callback?code=...` (existing infra), which
 * exchanges the code for a session and enforces the allowlist.
 *
 * A same-site `next` path survives the round trip via the `next` query
 * param on the callback URL, mirroring the password flow's behavior.
 *
 * Takes `_prevState` so the client can drive it through `useActionState`
 * (the repo's pending-state idiom) and lock the forms while it runs.
 */
export async function signInWithHugo(
  _prevState: void,
  formData: FormData,
): Promise<void> {
  // Fail closed: the NEXT_PUBLIC flag only hides the button client-side.
  // Anyone can POST the action directly, so enforce the gate here too.
  if (process.env.NEXT_PUBLIC_HUGO_SSO !== "1") {
    redirect("/login");
  }

  const next = sanitizeNextPath(formData.get("next"));

  let authUrl: string | null = null;
  try {
    const h = await headers();
    const proto = h.get("x-forwarded-proto") ?? "https";
    const host = h.get("host") ?? "sandra-sooty.vercel.app";
    const redirectTo = `${proto}://${host}/auth/callback${
      next ? `?next=${encodeURIComponent(next)}` : ""
    }`;

    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      // Custom OIDC providers use the `custom:` prefix; supabase-js's
      // Provider union accepts `custom:${string}` natively.
      provider: "custom:hugo",
      options: { redirectTo },
    });

    if (error) {
      reportError(new Error(error.message), {
        tags: { surface: "hugo_sso" },
      });
    } else {
      authUrl = data.url;
    }
  } catch (e) {
    reportError(e, { tags: { surface: "hugo_sso" } });
  }

  if (!authUrl) {
    // Preserve the destination so the password fallback still lands the
    // user on the lead/property they were headed to.
    redirect(
      next
        ? `/login?error=sso&next=${encodeURIComponent(next)}`
        : "/login?error=sso",
    );
  }
  redirect(authUrl);
}

export async function signIn(
  _prevState: Result<null> | null,
  formData: FormData,
): Promise<Result<null>> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  // Open-redirect protection — shared with the SSO flow (see safe-next.ts).
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
        error: {
          code: "AUTH_FAILED",
          message: error.message,
        },
      };
    }
  } catch (e) {
    reportError(e, { tags: { surface: "login_action" } });
    return errFromUnknown(e, "AUTH_FAILED");
  }

  redirect(next);
  return ok(null);
}
