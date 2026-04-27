"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

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

export async function signIn(
  _prevState: Result<null> | null,
  formData: FormData,
): Promise<Result<null>> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const nextRaw = String(formData.get("next") ?? "");
  // Open-redirect protection: only honor same-site relative paths.
  // Reject anything that doesn't start with "/" or that contains a scheme,
  // or that points back at /login (would loop).
  const next =
    nextRaw.startsWith("/") &&
    !nextRaw.startsWith("//") &&
    !nextRaw.startsWith("/login")
      ? nextRaw
      : "/properties";

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
