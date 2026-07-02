import type { SupabaseClient } from "@supabase/supabase-js";

import type { AiDispatchOutcome } from "@/lib/ai-responder/dispatch";
import type { AiReplyDelayProcessingMetadata } from "@/lib/ai-responder/types";
import type { Database, Json } from "@/lib/supabase/types";

export type InboundMessageState = {
  autoQualifiedAt?: string;
  ownerNotificationSentAt?: string;
  propertyEnrollmentsPausedAt?: string;
  aiResponder?:
    | (AiDispatchOutcome & { completedAt?: string })
    | AiReplyDelayProcessingMetadata
    | {
        outcome: "error";
        reason: "workflow_start_and_fallback_failed";
        completedAt: string;
      };
};

export function readInboundMessageState(metadata: Json | null): InboundMessageState {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const processing = (metadata as Record<string, unknown>).processing;
  if (
    !processing ||
    typeof processing !== "object" ||
    Array.isArray(processing)
  ) {
    return {};
  }
  return processing as InboundMessageState;
}

export async function markInboundMessageState(
  supabase: SupabaseClient<Database>,
  messageId: string,
  patch: InboundMessageState,
): Promise<void> {
  const { data: row, error: fetchError } = await supabase
    .from("messages")
    .select("metadata")
    .eq("id", messageId)
    .maybeSingle();
  if (fetchError) {
    throw new Error(`markInboundMessageState fetch: ${fetchError.message}`);
  }

  const currentMetadata =
    row?.metadata &&
    typeof row.metadata === "object" &&
    !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  const currentState = readInboundMessageState(row?.metadata ?? null);

  const { error: updateError } = await supabase
    .from("messages")
    .update({
      metadata: {
        ...currentMetadata,
        processing: {
          ...currentState,
          ...patch,
        },
      } as Json,
    })
    .eq("id", messageId);
  if (updateError) {
    throw new Error(`markInboundMessageState update: ${updateError.message}`);
  }
}
