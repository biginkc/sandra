"use server";

import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { err, type Result } from "@/lib/errors/result";
import { createClient } from "@/lib/supabase/server";

import { messagesV2OrgId } from "./access";
import { competingProperties, effectiveFlagReasons, loadEligibleHolds } from "./hold-list";
import { loadRunLabels } from "./labels";
import type { LooseSupabase } from "./queries";
import { chicagoDayWindow, loadRunsWindow, loadRunThreads, parseRunCursor, type RunCursor, type RunThread } from "./tape-data";
import type { RunLabel, RunWithSteps } from "./types";

export type TapeDayPage = {
  runs: RunWithSteps[];
  /** This day has runs older than the last one returned (continue the same day from it). */
  hasMore: boolean;
  labels: Array<[string, RunLabel]>;
  threads: Array<[string, RunThread]>;
  /** Runs whose thread text failed to load: the client retries them. */
  failedRunIds: string[];
  /**
   * [runId, flag reason] from the CURRENT eligible list, for runs on this day. The browser's snapshot map takes
   * precedence for any run the snapshot covers (so the tape matches the cards it shows); these fill in the rest.
   */
  flagReasons: Array<[string, string]>;
};

/**
 * "Show yesterday's tape": one America/Chicago calendar day (optionally only the part
 * older than a (started_at, id) cursor, for a day with more runs than a page). Caller and org are resolved on the server (same gate as the page);
 * only the boundary instant comes from the client.
 */
export async function loadTapeDayAction(input: { day: string; before?: RunCursor | null }): Promise<Result<TapeDayPage>> {
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
  const window = chicagoDayWindow(String(input?.day ?? ""));
  const before = parseRunCursor(input?.before);
  if (!window || (input?.before && !before)) return err({ code: "VALIDATION", message: "Missing day." });

  const supabase = (await createClient()) as unknown as LooseSupabase;
  const { runs, hasMore, error } = await loadRunsWindow(supabase, orgId, window.from, window.to, before);
  if (error) return err({ code: "TAPE_UNAVAILABLE", message: error });
  // Seeds: the day's runs' own properties, plus every hold that could claim one of the day's runs (a property-less
  // run's conversation, a source message, a draft run). The scoped build then grows to settle ownership.
  const linked = runs.length ? await competingProperties(supabase, orgId, runs) : new Set<string>();
  const dayPropertyIds = [...new Set([...runs.flatMap((r) => (r.property_id ? [r.property_id] : [])), ...(linked ?? [])])];
  const [labels, thread, list] = await Promise.all([
    loadRunLabels(supabase, runs),
    loadRunThreads(supabase, orgId, runs),
    // Only the holds that can own this day's runs. A failed link lookup claims no reasons (fill-in only; the
    // browser's snapshot map still covers page holds).
    linked && dayPropertyIds.length ? loadEligibleHolds(supabase, orgId, { propertyIds: dayPropertyIds }) : ({ ok: true, holds: [], unverified: 0 } as const),
  ]);
  const dayRunIds = new Set(runs.map((r) => r.id));
  const flagReasons = list.ok ? effectiveFlagReasons(list.holds).filter(([runId]) => dayRunIds.has(runId)) : [];
  return {
    ok: true,
    data: { runs, hasMore, labels: [...labels.entries()], threads: [...thread.threads.entries()], failedRunIds: thread.failedRunIds, flagReasons },
  };
}
