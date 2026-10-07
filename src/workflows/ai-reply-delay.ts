import Anthropic from "@anthropic-ai/sdk";
import { sleep } from "workflow";

import {
  dispatchAiResponse,
  type AiDispatchOutcome,
} from "@/lib/ai-responder/dispatch";
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
};

async function dispatchStep(
  params: AiReplyDelayParams,
): Promise<AiDispatchOutcome> {
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
    },
    {
      anthropic: new Anthropic(),
      checkSuperseded: true,
      ...(runContext ? { runContext } : {}),
    },
  );
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
  return dispatchStep(params);
}
