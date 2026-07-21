import { sanitizeNextPath } from "@/lib/auth/safe-next";
import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";

export type HugoStartResult =
  | { ok: true; authUrl: string }
  | { ok: false; next: string; reason: "disabled" | "unavailable" };

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
    const redirectTo = `${origin.replace(/\/$/, "")}/auth/callback${
      next ? `?next=${encodeURIComponent(next)}` : ""
    }`;
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "custom:hugo",
      options: { redirectTo },
    });

    if (error || !data.url) {
      if (error) {
        reportError(new Error(error.message), {
          tags: { surface: "hugo_sso" },
        });
      }
      return { ok: false, next, reason: "unavailable" };
    }
    return { ok: true, authUrl: data.url };
  } catch (error) {
    reportError(error, { tags: { surface: "hugo_sso" } });
    return { ok: false, next, reason: "unavailable" };
  }
}
