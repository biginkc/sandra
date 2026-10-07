import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { recordStep, type MaybeRunContext } from "@/lib/pipeline-runs";
import type { Database } from "@/lib/supabase/types";

import type { AiMessageMetadata } from "./types";

/** Seconds before a contended / failed-to-persist reply is re-dispatched. */
export const REPLY_RETRY_DELAY_SECONDS = 20;
/** Re-dispatches after the first attempt; the run after the last one is final. */
export const REPLY_RETRY_MAX = 3;

/**
 * Retry / flag matrix (Q8 rule 7 behind every flag below: the carried reply is
 * dead-lettered first - one retry of that write - and when that still fails
 * the flag reads `dead_letter_failed:<reason>`):
 *
 *  reason                     retries?  last attempt / when not retried
 *  send_reserved_elsewhere    yes       dead-letter + flag reply_skipped:<reason>
 *  send_lease_lost            yes       dead-letter + flag reply_skipped:<reason>
 *  send_preflight_timeout     yes       dead-letter + flag reply_skipped:<reason>
 *  reply_pending (rule 4)     yes       dead-letter + flag reply_skipped:<reason>
 *  draft_persist_failed       yes       dead-letter + flag draft_persist_failed
 *  send_timeout (not here)    NO        dead-letter + flag send_timeout (the provider
 *                                       request may still land; lease is kept)
 *  send_check_failed (n/h)    NO        dead-letter + flag send_check_failed (fails closed)
 *  claim_refused_on_retry     NO        dead-letter + flag reply_skipped:claim_refused_on_retry
 *  send_blocked:<status>      NO        dead-letter + flag send_blocked:<status> (incl.
 *                                       db_error, abort_unconfirmed, prior_attempt_failed)
 *  outside_business_hours /   NO        a pacing gate tripped during the retry gap: draft held +
 *   max_turns_reached                   dead-letter + flag reply_skipped:outside_business_hours
 *                                       or reply_skipped:max_turns_reached (rule 7)
 *  retry unschedulable        NO        dead-letter + flag reply_skipped:<reason>
 */
export type RetryReason =
  | "send_reserved_elsewhere"
  | "send_lease_lost"
  | "send_preflight_timeout"
  | "reply_pending"
  | "draft_persist_failed";

/**
 * The already-generated, already-safety-checked reply carried across a retry
 * so the re-dispatch neither re-classifies (no second Jev call) nor
 * re-generates it. It rides in the durable workflow params, never in a log:
 * nothing may pass it to reportError / trace detail.
 */
export type RetryReply = {
  body: string;
  confidence: number;
  sentiment: AiMessageMetadata["sentiment"];
  orgId: string;
  kind: "send_reply" | "deescalate_close" | "identity";
  /** deescalate_close only: the route reason for the follow-up disposition. */
  closeReason?: string;
};

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
  reply?: RetryReply;
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

/**
 * Durable last resort for a reply that could not be sent, stored or retried:
 * a row in ai_reply_dead_letters (RLS: owner||acquisitions read). Retries the
 * insert once; if that fails too it records a `dead_letter_failed` step and a
 * report carrying IDS ONLY (never the reply text). Returns whether a row landed.
 */
export async function writeReplyDeadLetter(
  supabase: SupabaseClient<Database>,
  ctx: MaybeRunContext,
  args: {
    orgId: string;
    conversationId: string | null;
    propertyId: string;
    inboundMessageId: string | null;
    body: string;
    reason: string;
    /**
     * Attempt-validity check (throws once the attempt is abandoned). Called
     * immediately before EACH insert (every retry iteration) and before the
     * failure step, OUTSIDE the try so its throw is never swallowed.
     */
    guard?: () => void;
  },
): Promise<boolean> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    args.guard?.();
    try {
      const { error } = await supabase.from("ai_reply_dead_letters").insert({
        org_id: args.orgId,
        run_id: ctx?.runId ?? null,
        conversation_id: args.conversationId,
        property_id: args.propertyId,
        inbound_message_id: args.inboundMessageId,
        body: args.body,
        reason: args.reason,
      });
      if (!error) return true;
      lastError = error.message;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  reportError(new Error(lastError ?? "dead letter insert failed"), {
    tags: { surface: "ai_responder_dead_letter_insert" },
    extra: { propertyId: args.propertyId, inboundMessageId: args.inboundMessageId, reason: args.reason },
  });
  args.guard?.();
  await recordStep(supabase, ctx, {
    kind: "action",
    name: "dead_letter_failed",
    result: "error",
    detail: {
      reason: args.reason,
      propertyId: args.propertyId,
      inboundMessageId: args.inboundMessageId,
    },
  });
  return false;
}
