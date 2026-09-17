import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { recordAiResponderDeliveryForThread } from "@/lib/messages/ai-responder-thread-state";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";
import type { SmsStatusEvent } from "./types";

type MessageStatusRow = Pick<
  Database["public"]["Tables"]["messages"]["Row"],
  | "id"
  | "org_id"
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
      "id, org_id, status, sent_at, delivered_at, failed_at, error_message, created_at, conversation_id, metadata",
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
  if (!update) {
    await recordRepSmsDeliveryFromMessage(supabase, providerId, event, message);
    return "skipped";
  }

  let query = supabase.from("messages").update(update).eq("id", message.id);
  if (event.kind === "delivered") {
    if (isProviderUnknownMessage(message)) {
      // provider_unknown is persisted as failed while the provider receipt is
      // unresolved. Allow only that exact placeholder state to be promoted;
      // a genuine terminal failure remains protected from late delivery.
      query = query
        .eq("status", "failed")
        .eq("metadata->>providerOutcome", "provider_unknown");
    } else {
      query = query.neq("status", "failed");
    }
  } else if (event.kind === "sent") {
    query = query.neq("status", "delivered").neq("status", "failed");
  } else if (event.kind === "failed") {
    query = query.neq("status", "delivered");
  }

  const { data: updatedRows, error: updateError } = await query.select("id");
  if (updateError) {
    throw new Error(`status update failed: ${updateError.message}`);
  }
  if ((updatedRows ?? []).length === 0) {
    await recordRepSmsDeliveryFromMessage(supabase, providerId, event, message);
    return "skipped";
  }
  await recordRepSmsDeliveryFromMessage(supabase, providerId, event, message);
  await recordAiResponderDeliveryForThread(supabase, {
    conversationId: message.conversation_id,
    messageId: message.id,
    metadata: message.metadata,
    event,
  });
  return "updated";
}

/**
 * Complete the durable rep-SMS obligation after the transport row has been
 * reconciled. Ordinary SMS traffic keeps its existing best-effort behavior.
 * Fenced rep-SMS callbacks (those carrying an obligation id) are part of the
 * durable obligation and bridge failures are propagated so the webhook event
 * remains retryable. Older/manual rep-SMS rows without an obligation id stay
 * best-effort when no legacy obligation matches the provider message id.
 *
 * The provider account identity is read only from the stored outbound
 * message's repSms metadata. The webhook supplies the provider message id
 * after it has already matched the authoritative messages row above.
 */
export async function recordRepSmsDeliveryFromMessage(
  supabase: SupabaseClient<Database>,
  providerId: string,
  event: SmsStatusEvent,
  message: Pick<MessageStatusRow, "id" | "org_id" | "metadata">,
): Promise<void> {
  if (event.kind === "sent") return;

  const identity = readRepSmsDeliveryIdentity(message.metadata);
  if (!identity || identity.provider.toLowerCase() !== providerId.toLowerCase()) {
    return;
  }

  try {
    // Delivery callbacks are service-only. `supabase` may be the signed-in
    // user client when this function is reached from sendSmsToContact's
    // reconciliation path, so never attempt the RPC on that client.
    const admin = createAdminClient();
    const result = await admin.rpc("fn_record_rep_sms_delivery", {
      p_provider: providerId,
      p_provider_account_id: identity.providerAccountId,
      p_provider_message_id: event.externalId,
      p_state: event.kind === "delivered" ? "delivered" : "delivery_failed",
      p_provider_status: event.kind,
      p_provider_error:
        event.kind === "failed"
          ? event.errorMessage ?? "Provider reported delivery failure."
          : null,
      p_metadata: {
        source: "sendillo_status_webhook",
        messageId: message.id,
        messageOrgId: message.org_id,
        eventTimestamp: event.timestamp.toISOString(),
      },
      ...(identity.obligationId
        ? {
            // A fenced rep send can receive a provider callback before the
            // worker's accepted-result write binds provider_message_id on the
            // obligation. The exact obligation/org path closes that race;
            // the RPC still verifies provider + account + tenant before it
            // binds the external id.
            p_org_id: message.org_id,
            p_obligation_id: identity.obligationId,
          }
        : {}),
    });

    if (result.error) {
      const bridgeError = new Error(result.error.message);
      // A valid rep-SMS identity is part of the durable delivery contract.
      // Leave the webhook row retryable when the service RPC is unavailable
      // or rejects the callback; ordinary messages never enter this block.
      throw bridgeError;
    }
    const bridgeResult = result.data;
    if (!isSuccessfulRepSmsDeliveryResult(bridgeResult)) {
      // Older/manual rep-SMS rows predate durable obligations. The callback
      // still gets a chance to reconcile a matching legacy obligation by
      // provider message id, but an unmatched row is intentionally a no-op;
      // otherwise every status replay would remain retryable forever.
      if (!identity.obligationId && isUnmatchedRepSmsDeliveryResult(bridgeResult)) {
        return;
      }
      const bridgeError = new Error(
        "Rep SMS delivery callback did not transition its obligation.",
      );
      throw bridgeError;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Avoid silently acknowledging a valid rep-SMS callback. The caller's
    // webhook/reconciliation boundary records the event as error, allowing a
    // later replay after the database/provider bridge is healthy.
    reportRepSmsDeliveryBridgeError(message);
    throw error;
  }
}

function isSuccessfulRepSmsDeliveryResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.ok === true && result.matched === true;
}

function isUnmatchedRepSmsDeliveryResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.ok === false && result.matched === false;
}

function readRepSmsDeliveryIdentity(
  metadata: Database["public"]["Tables"]["messages"]["Row"]["metadata"],
): { provider: string; providerAccountId: string; obligationId?: string } | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const repSms = metadata.repSms;
  if (!repSms || typeof repSms !== "object" || Array.isArray(repSms)) {
    return null;
  }
  const provider = repSms.provider;
  const providerAccountId = repSms.providerAccountId;
  const obligationId = repSms.obligationId;
  if (
    typeof provider !== "string" ||
    !provider.trim() ||
    typeof providerAccountId !== "string" ||
    !providerAccountId.trim()
  ) {
    return null;
  }
  return {
    provider: provider.trim(),
    providerAccountId: providerAccountId.trim(),
    ...(typeof obligationId === "string" && obligationId.trim()
      ? { obligationId: obligationId.trim() }
      : {}),
  };
}

function isProviderUnknownMessage(message: Pick<MessageStatusRow, "metadata" | "status">): boolean {
  if (message.status !== "failed") return false;
  if (!message.metadata || typeof message.metadata !== "object" || Array.isArray(message.metadata)) {
    return false;
  }
  return message.metadata.providerOutcome === "provider_unknown";
}

function reportRepSmsDeliveryBridgeError(message: string): void {
  reportError(new Error(`rep SMS delivery bridge failed: ${message}`), {
    tags: { surface: "rep_sms_delivery_bridge" },
  });
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
      const unresolvedProviderOutcome = isProviderUnknownMessage(message);
      if (message.status === "failed" && !unresolvedProviderOutcome) return null;
      if (!shouldApplyTimestamp(message.delivered_at, timestamp)) return null;
      const metadata = unresolvedProviderOutcome
        ? clearProviderUnknownMetadata(message.metadata)
        : undefined;
      return {
        status: "delivered",
        delivered_at: timestamp,
        ...(unresolvedProviderOutcome
          ? {
              failed_at: null,
              error_message: null,
              ...(metadata ? { metadata } : {}),
            }
          : {}),
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
      const metadata = isProviderUnknownMessage(message)
        ? clearProviderUnknownMetadata(message.metadata)
        : undefined;
      return {
        status: "failed",
        failed_at: shouldApplyTime ? timestamp : message.failed_at,
        error_message: nextErrorMessage ?? null,
        ...(metadata ? { metadata } : {}),
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

function clearProviderUnknownMetadata(
  metadata: MessageStatusRow["metadata"],
): MessageStatusUpdate["metadata"] | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  if (metadata.providerOutcome !== "provider_unknown") return undefined;
  const next = { ...metadata };
  delete next.providerOutcome;
  return next;
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
