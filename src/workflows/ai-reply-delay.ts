import Anthropic from "@anthropic-ai/sdk";
import { sleep } from "workflow";

import {
  dispatchAiResponse,
  type AiDispatchOutcome,
} from "@/lib/ai-responder/dispatch";
import {
  isRetryOutcome,
  recordRetryScheduled,
  type AiRetryOutcome,
  type RetryReply,
} from "@/lib/ai-responder/retry";
import { recordAiResponderOutcomeForThread } from "@/lib/messages/ai-responder-thread-state";
import { markInboundMessageState } from "@/lib/messaging/inbound-state";
import { finishRunFromOutcome, resumeRun } from "@/lib/pipeline-runs";
import { createAdminClient } from "@/lib/supabase/admin";

export type AiReplyDelayParams = {
  propertyId: string;
  contactId: string;
  conversationId: string | null;
  inboundFromPhone?: string | null;
  inboundToPhone?: string | null;
  inboundBody: string;
  inboundMessageId: string;
  delaySeconds: number;
  /** Messages v2 evidence run started by the webhook; optional. */
  runId?: string | null;
  /** 0/undefined = first dispatch; N = the Nth retry after a contended / failed reply. */
  retryAttempt?: number;
  /** The reply the previous attempt generated, re-sent verbatim (never logged). */
  retryReply?: RetryReply;
};

async function dispatchStep(
  params: AiReplyDelayParams,
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  "use step";

  const supabase = createAdminClient();
  const runContext = await resumeRun(supabase, params.runId);
  const outcome = await dispatchAiResponse(
    supabase,
    {
      propertyId: params.propertyId,
      contactId: params.contactId,
      conversationId: params.conversationId,
      inboundFromPhone: params.inboundFromPhone ?? null,
      inboundToPhone: params.inboundToPhone ?? null,
      inboundBody: params.inboundBody,
      inboundMessageId: params.inboundMessageId,
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.retryAttempt ? { retryAttempt: params.retryAttempt } : {}),
      ...(params.retryReply ? { retryReply: params.retryReply } : {}),
    },
    {
      anthropic: new Anthropic(),
      checkSuperseded: true,
      ...(runContext ? { runContext } : {}),
    },
  );
  if (isRetryOutcome(outcome)) {
    // Not terminal: the run stays `running`, the inbound is NOT stamped, and
    // the workflow below sleeps and dispatches the same inbound again.
    await recordRetryScheduled(supabase, runContext, outcome);
    return outcome;
  }
  await finishRunFromOutcome(supabase, runContext, outcome);
  const completedAt = new Date().toISOString();
  await recordAiResponderOutcomeForThread(supabase, {
    conversationId: params.conversationId,
    outcome,
    completedAt,
  });
  await markInboundMessageState(supabase, params.inboundMessageId, {
    aiResponder: {
      ...outcome,
      completedAt,
    },
  });

  return outcome;
}

export async function aiReplyDelayWorkflow(
  params: AiReplyDelayParams,
): Promise<AiDispatchOutcome> {
  "use workflow";

  if (params.delaySeconds > 0) {
    await sleep(`${params.delaySeconds}s`);
  }
  let outcome = await dispatchStep(params);
  // Bounded: dispatch itself returns a terminal outcome once retryAttempt
  // reaches REPLY_RETRY_MAX (dead-letter + flag), so this loop always ends.
  while (isRetryOutcome(outcome)) {
    await sleep(`${outcome.delaySeconds}s`);
    outcome = await dispatchStep({
      ...params,
      retryAttempt: outcome.attempt,
      ...(outcome.reply ? { retryReply: outcome.reply } : {}),
    });
  }
  return outcome;
}
