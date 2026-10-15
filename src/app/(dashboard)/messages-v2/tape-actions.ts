"use server";

import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { err, type Result } from "@/lib/errors/result";
import { createClient } from "@/lib/supabase/server";

import { messagesV2OrgId } from "./access";
import { loadRunLabels } from "./labels";
import type { LooseSupabase } from "./queries";
import { chicagoDayWindow, loadRunsWindow, loadRunThreads, type RunThread } from "./tape-data";
import type { RunLabel, RunWithSteps } from "./types";

export type TapeDayPage = {
  runs: RunWithSteps[];
  labels: Array<[string, RunLabel]>;
  threads: Array<[string, RunThread]>;
};

/**
 * "Show yesterday's tape": one America/Chicago calendar day (optionally only the part
 * older than a cursor, for a day with more runs than a page). Caller and org are resolved on the server (same gate as the page);
 * only the boundary instant comes from the client.
 */
export async function loadTapeDayAction(input: { day: string; before?: string | null }): Promise<Result<TapeDayPage>> {
  let orgId: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user?.id) {
      const memberships = (await getCallerMembershipsOrThrow()).filter((m) => m.user_id === user.id);
      orgId = messagesV2OrgId(memberships);
    }
  } catch {
    orgId = null;
  }
  if (!orgId) return err({ code: "UNAUTHORIZED", message: "You do not have access to Messages v2." });
  const window = chicagoDayWindow(String(input?.day ?? ""), input?.before ? String(input.before) : null);
  if (!window) return err({ code: "VALIDATION", message: "Missing day." });

  const supabase = (await createClient()) as unknown as LooseSupabase;
  const { runs, error } = await loadRunsWindow(supabase, orgId, window.from, window.to);
  if (error) return err({ code: "TAPE_UNAVAILABLE", message: error });
  const [labels, threads] = await Promise.all([loadRunLabels(supabase, runs), loadRunThreads(supabase, runs)]);
  return { ok: true, data: { runs, labels: [...labels.entries()], threads: [...threads.entries()] } };
}
