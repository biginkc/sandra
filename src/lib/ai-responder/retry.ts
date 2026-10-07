import type { SupabaseClient } from "@supabase/supabase-js";

import { recordStep, type MaybeRunContext } from "@/lib/pipeline-runs";
import type { Database } from "@/lib/supabase/types";

/** Seconds before a contended / failed-to-persist reply is re-dispatched. */
export const REPLY_RETRY_DELAY_SECONDS = 20;
/** Re-dispatches after the first attempt; the run after the last one is final. */
export const REPLY_RETRY_MAX = 3;

export type RetryReason =
  | "send_reserved_elsewhere"
  | "send_lease_lost"
  | "draft_persist_failed";

/**
 * Returned (never thrown) when nothing was sent or stored and the same inbound
 * should be dispatched again. The claim is left reclaimable, the pipeline run
 * stays `running`, and the CALLER schedules the retry through the delay
 * workflow (webhook wrapper: `start(aiReplyDelayWorkflow, retryAttempt)`;
 * workflow wrapper: sleep + dispatch again). `attempt` is the retry number the
 * next dispatch runs as (1..REPLY_RETRY_MAX).
 */
export type AiRetryOutcome = {
  outcome: "retry";
  reason: RetryReason;
  attempt: number;
  delaySeconds: number;
};

export function isRetryOutcome(value: { outcome: string }): value is AiRetryOutcome {
  return value.outcome === "retry";
}

/** Evidence step: the run is intentionally still open and will be retried. */
export async function recordRetryScheduled(
  supabase: SupabaseClient<Database>,
  ctx: MaybeRunContext,
  retry: AiRetryOutcome,
): Promise<void> {
  await recordStep(supabase, ctx, {
    kind: "action",
    name: "retry_scheduled",
    result: "applied",
    detail: {
      reason: retry.reason,
      attempt: retry.attempt,
      maxAttempts: REPLY_RETRY_MAX,
      delaySeconds: retry.delaySeconds,
    },
  });
}
