"use server";

import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";

/** Password updates exist only for the flag-off emergency rollback path. */
export async function setPassword(password: string): Promise<Result<null>> {
  if (process.env.NEXT_PUBLIC_HUGO_SSO === "1") {
    return {
      ok: false,
      error: {
        code: "PASSWORD_DISABLED",
        message: "Sandra passwords are disabled. Continue with Hugo.",
      },
    };
  }
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
  } catch (error) {
    reportError(error, { tags: { surface: "set_password" } });
    return errFromUnknown(error, "PASSWORD_UPDATE_FAILED");
  }
}
