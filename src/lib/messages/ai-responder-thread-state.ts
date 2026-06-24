import type { SupabaseClient } from "@supabase/supabase-js";

import type { AiDispatchOutcome } from "@/lib/ai-responder/dispatch";
import { reportError } from "@/lib/errors/report";
import type { SmsStatusEvent } from "@/lib/messaging/types";
import type { Database, Json } from "@/lib/supabase/types";

export type AiResponderThreadStatus = "handled" | "escalated";

type MessageDeliveryRow = Pick<
  Database["public"]["Tables"]["messages"]["Row"],
  "status" | "error_message"
>;

type ThreadStateUpdate = Database["public"]["Tables"]["message_threads"]["Update"];

export async function clearAiResponderThreadState(
  supabase: SupabaseClient<Database>,
  conversationId: string | null | undefined,
): Promise<void> {
  if (!conversationId) return;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("message_threads")
    .update({
      ai_responder_status: null,
      ai_responder_reason: null,
      ai_responder_status_at: null,
      ai_last_delivery_status: null,
      ai_last_delivery_error: null,
      updated_at: now,
    })
    .eq("conversation_id", conversationId);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_thread_state_clear" },
      extra: { conversationId },
    });
  }
}

export async function recordAiResponderOutcomeForThread(
  supabase: SupabaseClient<Database>,
  args: {
    conversationId: string | null | undefined;
    outcome: AiDispatchOutcome;
    completedAt?: string;
  },
): Promise<void> {
  if (!args.conversationId) return;

  const next = await buildOutcomeUpdate(supabase, args.outcome, args.completedAt);
  if (!next) return;
  const statusAt = next.ai_responder_status_at ?? new Date().toISOString();

  const { error } = await supabase
    .from("message_threads")
    .update({
      ...next,
      updated_at: statusAt,
    })
    .eq("conversation_id", args.conversationId);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_thread_state_record" },
      extra: {
        conversationId: args.conversationId,
        outcome: args.outcome.outcome,
      },
    });
  }
}

export async function recordAiResponderDeliveryForThread(
  supabase: SupabaseClient<Database>,
  args: {
    conversationId: string | null;
    metadata: Json | null;
    event: SmsStatusEvent;
  },
): Promise<void> {
  if (!args.conversationId || !isAiResponderMessageMetadata(args.metadata)) {
    return;
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("message_threads")
    .update({
      ai_last_delivery_status: args.event.kind,
      ai_last_delivery_error:
        args.event.kind === "failed" ? args.event.errorMessage ?? null : null,
      updated_at: now,
    })
    .eq("conversation_id", args.conversationId);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_thread_delivery_record" },
      extra: {
        conversationId: args.conversationId,
        status: args.event.kind,
      },
    });
  }
}

function isAiResponderMessageMetadata(metadata: Json | null): boolean {
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, Json>).generated_by === "ai_responder_v1"
  );
}

async function buildOutcomeUpdate(
  supabase: SupabaseClient<Database>,
  outcome: AiDispatchOutcome,
  completedAt?: string,
): Promise<ThreadStateUpdate | null> {
  const statusAt = completedAt ?? new Date().toISOString();

  switch (outcome.outcome) {
    case "sent": {
      const delivery = await loadMessageDelivery(supabase, outcome.messageId);
      return {
        ai_responder_status: "handled",
        ai_responder_reason: "sent",
        ai_responder_status_at: statusAt,
        ai_last_delivery_status: delivery?.status ?? "sent",
        ai_last_delivery_error: delivery?.error_message ?? null,
      };
    }
    case "auto_closed":
    case "opted_out":
      return {
        ai_responder_status: "handled",
        ai_responder_reason: outcome.reason,
        ai_responder_status_at: statusAt,
        ai_last_delivery_status: null,
        ai_last_delivery_error: null,
      };
    case "escalated":
      return {
        ai_responder_status: "escalated",
        ai_responder_reason: outcome.reason,
        ai_responder_status_at: statusAt,
        ai_last_delivery_status: null,
        ai_last_delivery_error: null,
      };
    case "skipped":
      return null;
  }
}

async function loadMessageDelivery(
  supabase: SupabaseClient<Database>,
  messageId: string,
): Promise<MessageDeliveryRow | null> {
  const { data, error } = await supabase
    .from("messages")
    .select("status, error_message")
    .eq("id", messageId)
    .maybeSingle();
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "ai_responder_thread_delivery_lookup" },
      extra: { messageId },
    });
    return null;
  }
  return data;
}
