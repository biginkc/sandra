"use server";

import { revalidatePath } from "next/cache";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { reportError } from "@/lib/errors/report";
import type { Result } from "@/lib/errors/result";
import { captureSkipTraceBalanceSnapshot } from "@/lib/skip-trace/balance";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function refreshSkipTraceBalanceAction(): Promise<
  Result<{ credits: number; capturedAt: string }>
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Not signed in" },
    };
  }
  if (!isAdminEmail(user.email)) {
    return {
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "Only an administrator can refresh provider credits",
      },
    };
  }

  try {
    const snapshot = await captureSkipTraceBalanceSnapshot(createAdminClient());
    revalidatePath("/dashboard");
    return {
      ok: true,
      data: { credits: snapshot.credits, capturedAt: snapshot.capturedAt },
    };
  } catch (error) {
    reportError(error, {
      tags: { surface: "manual_skip_trace_balance_refresh" },
    });
    return {
      ok: false,
      error: {
        code: "BALANCE_REFRESH_FAILED",
        message: "Could not refresh provider credits. The last reading is unchanged.",
      },
    };
  }
}
