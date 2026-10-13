import type { SupabaseClient } from "@supabase/supabase-js";

import { drainNormaFollowupNotices, type NormaFollowupNoticeSummary } from "./followup-notice";
import { drainNormaNotifications, type NormaNotificationSummary, type NormaSlackPost } from "./slack-worker";

/**
 * One deadline for the whole norma-notifications cron run. The route's maxDuration is 60 s; the two drains run one after the
 * other, so each used to get its own fresh 45 s budget and the second could run past termination. Now both are measured against
 * a single total, and the call-summary drain is capped so a slice is always left for the follow-up notices.
 */
export const NORMA_CRON_MAX_DURATION_MS = 60_000; // keep equal to `maxDuration` in the route
export const NORMA_CRON_SAFETY_MS = 10_000;
export const NORMA_CRON_TOTAL_MS = NORMA_CRON_MAX_DURATION_MS - NORMA_CRON_SAFETY_MS;
export const NORMA_FOLLOWUP_MIN_SLICE_MS = 15_000;
export const NORMA_SUMMARY_BUDGET_MS = NORMA_CRON_TOTAL_MS - NORMA_FOLLOWUP_MIN_SLICE_MS;

/** What is left of the shared total after `elapsedMs`; never negative. */
export const remainingCronBudgetMs = (elapsedMs: number) => Math.max(0, NORMA_CRON_TOTAL_MS - elapsedMs);

export type NormaNotificationsCronResult = {
  summary: NormaNotificationSummary;
  followups: NormaFollowupNoticeSummary | { error: string };
};

export async function runNormaNotificationsCron(deps: {
  client: SupabaseClient;
  post: NormaSlackPost | null;
  clock?: () => number;
  now?: number;
  onFollowupError?: (error: unknown) => void;
}): Promise<NormaNotificationsCronResult> {
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const summary = await drainNormaNotifications({ client: deps.client as never, post: deps.post, now: deps.now, clock, budgetMs: NORMA_SUMMARY_BUDGET_MS });
  // Follow-up notices ride the same cron and poster. A failure here must never hide the call-summary result.
  try {
    const followups = await drainNormaFollowupNotices({ client: deps.client, post: deps.post, now: deps.now, clock, budgetMs: remainingCronBudgetMs(clock() - startedAt) });
    return { summary, followups };
  } catch (error) {
    deps.onFollowupError?.(error);
    return { summary, followups: { error: "followup_notice_failed" } };
  }
}
