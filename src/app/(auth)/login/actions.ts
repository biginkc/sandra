"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";

export async function signIn(
  _prevState: Result<null> | null,
  formData: FormData,
): Promise<Result<null>> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

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

  redirect("/properties");
  return ok(null);
}
