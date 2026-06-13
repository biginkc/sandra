import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError, reportInfo } from "@/lib/errors/report";
import { getWebhookProvider } from "@/lib/messaging/registry";
import {
  applyMessageStatusEvent,
  statusWebhookEventType,
} from "@/lib/messaging/status-events";
import type { SmsStatusEvent } from "@/lib/messaging/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types";

export const runtime = "nodejs";
const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60_000;

export async function POST(request: Request) {
  try {
    const provider = getWebhookProvider("sendillo");
    if (!provider) {
      return NextResponse.json(
        { error: "Messaging provider not configured" },
        { status: 503 },
      );
    }
    if (!provider.parseStatusWebhook) {
      return NextResponse.json(
        { error: "Messaging provider has no status webhook parser" },
        { status: 503 },
      );
    }

    const rawBody = await request.text();
    const fullUrl = new URL(
      request.url,
      `https://${request.headers.get("host") ?? "example.invalid"}`,
    ).toString();

    if (!provider.verifyWebhookSignature(rawBody, request.headers, fullUrl)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    let events: SmsStatusEvent[];
    try {
      events = provider.parseStatusWebhook(rawBody);
    } catch (error) {
      reportError(error, {
        tags: { surface: "sendillo_status_webhook_parse" },
      });
      return NextResponse.json(
        { error: "Unrecognized payload" },
        { status: 400 },
      );
    }

    const supabase = createAdminClient();
    const parsedPayload = safeParseJson(rawBody);
    for (const event of events) {
      const eventType = statusWebhookEventType(event.kind);
      const reservation = await reserveStatusWebhookEvent(supabase, {
        provider: provider.providerId,
        eventType,
        externalId: event.externalId,
        payload: {
          kind: event.kind,
          timestamp: event.timestamp.toISOString(),
          errorMessage: event.errorMessage ?? null,
          rawBody,
          parsed: parsedPayload,
        } as Json,
      });

      if (reservation.status === "skip") continue;
      if (reservation.status === "error") {
        reportError(new Error(reservation.message), {
          tags: { surface: "sendillo_status_webhook_events_insert" },
          extra: { externalId: event.externalId, eventType },
        });
        return NextResponse.json(
          { error: "webhook event reserve failed" },
          { status: 500 },
        );
      }

      try {
        const outcome = await applyMessageStatusEvent(
          supabase,
          provider.providerId,
          event,
        );
        if (outcome === "unknown") {
          reportInfo("Sendillo status webhook referenced unknown message", {
            tags: { surface: "sendillo_status_webhook_unknown_message" },
            extra: { externalId: event.externalId, kind: event.kind },
          });
          await markStatusWebhookEventError(
            supabase,
            provider.providerId,
            eventType,
            event.externalId,
            "message not found",
          );
          continue;
        }
        await markStatusWebhookEventProcessed(
          supabase,
          provider.providerId,
          eventType,
          event.externalId,
        );
      } catch (error) {
        await markStatusWebhookEventError(
          supabase,
          provider.providerId,
          eventType,
          event.externalId,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    }

    return NextResponse.json({ ok: true, processed: events.length });
  } catch (error) {
    reportError(error, { tags: { surface: "sendillo_status_webhook_unexpected" } });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "unknown" },
      { status: 500 },
    );
  }
}

function safeParseJson(rawBody: string): Json | null {
  try {
    return JSON.parse(rawBody) as Json;
  } catch {
    return null;
  }
}

async function reserveStatusWebhookEvent(
  supabase: SupabaseClient<Database>,
  input: {
    provider: string;
    eventType: string;
    externalId: string;
    payload: Json;
  },
): Promise<
  | { status: "reserved" }
  | { status: "skip" }
  | { status: "error"; message: string }
> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("webhook_events").insert({
    provider: input.provider,
    event_type: input.eventType,
    external_id: input.externalId,
    signature_verified: true,
    processing_status: "processing",
    processing_started_at: now,
    payload: input.payload,
  });
  if (!error) return { status: "reserved" };
  if (isMissingWebhookProcessingClaimSupport(error.message)) {
    return reserveStatusWebhookEventLegacy(supabase, input);
  }
  if (error.code !== "23505") {
    return { status: "error", message: error.message };
  }

  const { data: existing, error: existingError } = await supabase
    .from("webhook_events")
    .select("processing_status, processing_started_at")
    .eq("provider", input.provider)
    .eq("event_type", input.eventType)
    .eq("external_id", input.externalId)
    .maybeSingle();
  if (existingError) return { status: "error", message: existingError.message };
  if (existing?.processing_status === "processed") return { status: "skip" };
  if (
    existing?.processing_status === "processing" &&
    !isWebhookProcessingLeaseExpired(existing.processing_started_at)
  ) {
    return { status: "skip" };
  }

  let claim = supabase
    .from("webhook_events")
    .update({
      processing_status: "processing",
      processing_started_at: now,
      processed_at: null,
      error_message: null,
      signature_verified: true,
      payload: input.payload,
    })
    .eq("provider", input.provider)
    .eq("event_type", input.eventType)
    .eq("external_id", input.externalId);

  if (existing?.processing_status) {
    claim = claim.eq("processing_status", existing.processing_status);
  }
  if (existing?.processing_started_at) {
    claim = claim.eq("processing_started_at", existing.processing_started_at);
  } else {
    claim = claim.is("processing_started_at", null);
  }

  const { data: claimed, error: claimError } = await claim
    .select("id")
    .maybeSingle();
  if (claimError) return { status: "error", message: claimError.message };
  if (!claimed) return { status: "skip" };
  return { status: "reserved" };
}

async function reserveStatusWebhookEventLegacy(
  supabase: SupabaseClient<Database>,
  input: {
    provider: string;
    eventType: string;
    externalId: string;
    payload: Json;
  },
): Promise<
  | { status: "reserved" }
  | { status: "skip" }
  | { status: "error"; message: string }
> {
  const { error } = await supabase.from("webhook_events").insert({
    provider: input.provider,
    event_type: input.eventType,
    external_id: input.externalId,
    signature_verified: true,
    processing_status: "pending",
    payload: input.payload,
  });
  if (!error) return { status: "reserved" };
  if (error.code !== "23505") {
    return { status: "error", message: error.message };
  }

  const { data: existing, error: existingError } = await supabase
    .from("webhook_events")
    .select("processing_status")
    .eq("provider", input.provider)
    .eq("event_type", input.eventType)
    .eq("external_id", input.externalId)
    .maybeSingle();
  if (existingError) return { status: "error", message: existingError.message };
  if (existing?.processing_status === "processed") return { status: "skip" };
  return {
    status: "error",
    message:
      "legacy webhook replay cannot be safely claimed without processing_started_at support",
  };
}

async function markStatusWebhookEventProcessed(
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
    throw new Error(`markStatusWebhookEventProcessed: ${error.message}`);
  }
  if ((data ?? []).length !== 1) {
    throw new Error(
      `markStatusWebhookEventProcessed: expected one webhook event for ${provider}/${eventType}/${externalId}`,
    );
  }
}

async function markStatusWebhookEventError(
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
    throw new Error(`markStatusWebhookEventError: ${error.message}`);
  }
  if ((data ?? []).length !== 1) {
    throw new Error(
      `markStatusWebhookEventError: expected one webhook event for ${provider}/${eventType}/${externalId}`,
    );
  }
}

function isWebhookProcessingLeaseExpired(
  processingStartedAt: string | null,
): boolean {
  if (!processingStartedAt) return true;
  const startedAt = new Date(processingStartedAt).getTime();
  if (Number.isNaN(startedAt)) return true;
  return Date.now() - startedAt > WEBHOOK_PROCESSING_LEASE_MS;
}

function isMissingWebhookProcessingClaimSupport(message: string): boolean {
  return (
    message.includes("processing_started_at") ||
    (message.includes("processing_status") &&
      message.includes("check constraint"))
  );
}
