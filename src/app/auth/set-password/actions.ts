"use server";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";

/**
 * Update the authenticated user's password. Called from the
 * /auth/set-password form (first-time invite acceptance) and
 * reused if we add a change-password UI later.
 */
export async function setPassword(password: string): Promise<Result<null>> {
  if (password.length < 8) {
    return {
      ok: false,
      error: {
        code: "PASSWORD_TOO_SHORT",
        message: "Password must be at least 8 characters.",
      },
    };
  }
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      return {
        ok: false,
        error: { code: "PASSWORD_UPDATE_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "set_password" } });
    return errFromUnknown(e, "PASSWORD_UPDATE_FAILED");
  }
}
