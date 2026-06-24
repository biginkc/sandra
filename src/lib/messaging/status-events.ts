import type { SupabaseClient } from "@supabase/supabase-js";

import { recordAiResponderDeliveryForThread } from "@/lib/messages/ai-responder-thread-state";
import type { Database } from "@/lib/supabase/types";
import type { SmsStatusEvent } from "./types";

type MessageStatusRow = Pick<
  Database["public"]["Tables"]["messages"]["Row"],
  | "id"
  | "status"
  | "sent_at"
  | "delivered_at"
  | "failed_at"
  | "error_message"
  | "created_at"
  | "conversation_id"
  | "metadata"
>;

type MessageStatusUpdate = Database["public"]["Tables"]["messages"]["Update"];

type WebhookEventRow = Pick<
  Database["public"]["Tables"]["webhook_events"]["Row"],
  "event_type" | "external_id" | "payload"
>;

export function statusWebhookEventType(kind: SmsStatusEvent["kind"]): string {
  return `sms_status_${kind}`;
}

export async function applyMessageStatusEvent(
  supabase: SupabaseClient<Database>,
  providerId: string,
  event: SmsStatusEvent,
): Promise<"updated" | "skipped" | "unknown"> {
  const { data: messages, error } = await supabase
    .from("messages")
    .select(
      "id, status, sent_at, delivered_at, failed_at, error_message, created_at, conversation_id, metadata",
    )
    .eq("external_id", event.externalId)
    .eq("provider", providerId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(2);

  if (error) {
    throw new Error(`status lookup failed: ${error.message}`);
  }
  if ((messages?.length ?? 0) > 1) {
    throw new Error(
      `status lookup matched multiple outbound messages for ${providerId}/${event.externalId}`,
    );
  }
  const message = messages?.[0] as MessageStatusRow | undefined;
  if (!message) return "unknown";

  const update = buildStatusUpdate(message, event);
  if (!update) return "skipped";

  let query = supabase.from("messages").update(update).eq("id", message.id);
  if (event.kind === "delivered") {
    query = query.neq("status", "failed");
  } else if (event.kind === "sent") {
    query = query.neq("status", "delivered").neq("status", "failed");
  } else if (event.kind === "failed") {
    query = query.neq("status", "delivered");
  }

  const { error: updateError } = await query;
  if (updateError) {
    throw new Error(`status update failed: ${updateError.message}`);
  }
  await recordAiResponderDeliveryForThread(supabase, {
    conversationId: message.conversation_id,
    metadata: message.metadata,
    event,
  });
  return "updated";
}

export async function reconcileStoredStatusEvents(
  supabase: SupabaseClient<Database>,
  providerId: string,
  externalId: string,
) {
  const eventTypes = [
    statusWebhookEventType("sent"),
    statusWebhookEventType("delivered"),
    statusWebhookEventType("failed"),
  ];

  const { data: rows, error } = await supabase
    .from("webhook_events")
    .select("event_type, external_id, payload")
    .eq("provider", providerId)
    .eq("external_id", externalId)
    .in("event_type", eventTypes)
    .neq("processing_status", "processed")
    .order("received_at", { ascending: true });
  if (error) {
    throw new Error(`status webhook reconciliation lookup failed: ${error.message}`);
  }

  for (const row of rows ?? []) {
    try {
      const event = parseStoredStatusEvent(row as WebhookEventRow);
      const outcome = await applyMessageStatusEvent(supabase, providerId, event);
      if (outcome === "unknown") {
        await markWebhookEventError(
          supabase,
          providerId,
          row.event_type,
          row.external_id,
          "message not found",
        );
        continue;
      }
      await markWebhookEventProcessed(
        supabase,
        providerId,
        row.event_type,
        row.external_id,
      );
    } catch (reconcileError) {
      await markWebhookEventError(
        supabase,
        providerId,
        row.event_type,
        row.external_id,
        reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
      );
    }
  }
}

function buildStatusUpdate(
  message: MessageStatusRow,
  event: SmsStatusEvent,
): MessageStatusUpdate | null {
  const timestamp = event.timestamp.toISOString();

  switch (event.kind) {
    case "delivered": {
      if (message.status === "failed") return null;
      if (!shouldApplyTimestamp(message.delivered_at, timestamp)) return null;
      return {
        status: "delivered",
        delivered_at: timestamp,
      };
    }
    case "sent": {
      if (message.status === "delivered" || message.status === "failed") {
        return null;
      }
      if (!shouldApplyTimestamp(message.sent_at, timestamp)) return null;
      return {
        status: "sent",
        sent_at: timestamp,
      };
    }
    case "failed": {
      if (message.status === "delivered") return null;
      const nextErrorMessage = event.errorMessage ?? message.error_message;
      const shouldApplyTime = shouldApplyTimestamp(message.failed_at, timestamp);
      const shouldApplyError =
        shouldApplyTime &&
        Boolean(nextErrorMessage) &&
        nextErrorMessage !== message.error_message;
      if (!shouldApplyTime && !shouldApplyError) return null;
      return {
        status: "failed",
        failed_at: shouldApplyTime ? timestamp : message.failed_at,
        error_message: nextErrorMessage ?? null,
      };
    }
  }
}

function shouldApplyTimestamp(current: string | null, next: string): boolean {
  if (!current) return true;
  const currentMs = new Date(current).getTime();
  const nextMs = new Date(next).getTime();
  if (Number.isNaN(currentMs) || Number.isNaN(nextMs)) return true;
  return nextMs > currentMs;
}

function parseStoredStatusEvent(row: WebhookEventRow): SmsStatusEvent {
  if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) {
    throw new Error(`stored status payload for ${row.event_type} was not an object`);
  }

  const payload = row.payload as Record<string, unknown>;
  const kind = payload.kind;
  const timestamp = payload.timestamp;
  const errorMessage = payload.errorMessage;

  if (kind !== "sent" && kind !== "delivered" && kind !== "failed") {
    throw new Error(`stored status payload had invalid kind: ${String(kind)}`);
  }
  if (typeof timestamp !== "string") {
    throw new Error(`stored status payload missing timestamp for ${row.event_type}`);
  }

  const parsedTimestamp = new Date(timestamp);
  if (Number.isNaN(parsedTimestamp.getTime())) {
    throw new Error(`stored status payload had invalid timestamp: ${timestamp}`);
  }

  return {
    kind,
    externalId: row.external_id,
    timestamp: parsedTimestamp,
    ...(typeof errorMessage === "string" && errorMessage.length > 0
      ? { errorMessage }
      : {}),
  };
}

async function markWebhookEventProcessed(
  supabase: SupabaseClient<Database>,
  provider: string,
  eventType: string,
  externalId: string,
) {
  const { data, error } = await supabase
    .from("webhook_events")
    .update({
      processing_status: "processed",
      processed_at: new Date().toISOString(),
    })
    .eq("provider", provider)
    .eq("event_type", eventType)
    .eq("external_id", externalId)
    .select("id");
  if (error) {
    throw new Error(`markWebhookEventProcessed: ${error.message}`);
  }
  if ((data ?? []).length !== 1) {
    throw new Error(
      `markWebhookEventProcessed: expected one webhook event for ${provider}/${eventType}/${externalId}`,
    );
  }
}

async function markWebhookEventError(
  supabase: SupabaseClient<Database>,
  provider: string,
  eventType: string,
  externalId: string,
  message: string,
) {
  const { data, error } = await supabase
    .from("webhook_events")
    .update({
      processing_status: "error",
      processed_at: new Date().toISOString(),
      error_message: message,
    })
    .eq("provider", provider)
    .eq("event_type", eventType)
    .eq("external_id", externalId)
    .select("id");
  if (error) {
    throw new Error(`markWebhookEventError: ${error.message}`);
  }
  if ((data ?? []).length !== 1) {
    throw new Error(
      `markWebhookEventError: expected one webhook event for ${provider}/${eventType}/${externalId}`,
    );
  }
}
