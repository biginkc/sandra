import { NextResponse } from "next/server";
import {
  createClient as createSupabaseClient,
  type SupabaseClient,
} from "@supabase/supabase-js";

import Anthropic from "@anthropic-ai/sdk";

import { listAdminUserIds } from "@/lib/auth/admins";
import { dispatchAiResponse } from "@/lib/ai-responder/dispatch";
import { reportError } from "@/lib/errors/report";
import { classifyReplyIntent } from "@/lib/leads/classify-reply-intent";
import { qualifyProperty } from "@/lib/leads/qualify";
import { resolveInboundThread } from "@/lib/messages/threading";
import { normalizePhone } from "@/lib/csv/normalize";
import { recordConsentEvent } from "@/lib/messaging/consent";
import { dispatchOwnerMessageAdded } from "@/lib/notifications/dispatch";
import {
  pauseContactEnrollments,
  pausePropertyEnrollments,
} from "@/lib/sequences/enrollment";
import type { Database, Json } from "@/lib/supabase/types";
import type { MessagingProvider } from "./types";

const STOP_KEYWORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|opt out|opt-out|remove)\s*$/i;
const HELP_KEYWORDS = /^\s*(help|info|support)\s*$/i;
const DNC_KEYWORDS = /do not (call|text|contact|reach out|message)|don'?t (call|text|contact|reach out|message)|stop (texting|calling|contacting) me|take me off|no more (texts|messages|calls)|remove me from|stop reaching out/i;
const WRONG_NUMBER_KEYWORDS = /wrong number|wrong person|not the owner|don'?t own|dont own|no longer own/i;

type InboundMessageRow = {
  id: string;
  contact_id: string | null;
  property_id: string | null;
  conversation_id: string | null;
  metadata: Json | null;
};

function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Inbound webhook needs SUPABASE_SERVICE_ROLE_KEY in .env.local to write past RLS.",
    );
  }
  return createSupabaseClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function handleInboundWebhook(
  request: Request,
  opts: { includeFullUrl: boolean; provider: MessagingProvider | null },
) {
  try {
    const { provider } = opts;
    if (!provider) {
      return NextResponse.json(
        { error: "Messaging provider not configured" },
        { status: 503 },
      );
    }

    const rawBody = await request.text();
    const fullUrl = opts.includeFullUrl
      ? new URL(
          request.url,
          `https://${request.headers.get("host") ?? "example.invalid"}`,
        ).toString()
      : undefined;

    if (!provider.verifyWebhookSignature(rawBody, request.headers, fullUrl)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    let events;
    try {
      events = provider.parseInboundWebhook(rawBody);
    } catch (e) {
      reportError(e, {
        tags: { surface: `${provider.providerId}_webhook_parse` },
      });
      return NextResponse.json({ error: "Unrecognized payload" }, { status: 400 });
    }

    const supabase = createServiceRoleClient();

    for (const ev of events) {
      const resumeDecision = await reserveWebhookEvent(supabase, {
        provider: provider.providerId,
        externalId: ev.externalId,
        payload: ev.raw as Json,
      });
      if (resumeDecision.status === "skip") continue;
      if (resumeDecision.status === "error") {
        reportError(new Error(resumeDecision.message), {
          tags: { surface: `${provider.providerId}_webhook_events_insert` },
          extra: { externalId: ev.externalId },
        });
        return NextResponse.json({ error: "webhook event reserve failed" }, { status: 500 });
      }

      const thread = await resolveInboundThread(supabase, ev.from, ev.to);
      const contactId = thread.contactId;
      const propertyId = thread.propertyId;
      const conversationId = thread.conversationId;
      const source = `${provider.providerId}_inbound_webhook`;
      const bodyTrimmed = ev.body.trim();
      const baseMetadata = {
        routing: thread.resolution,
        ...(ev.mediaUrls ? { mediaUrls: ev.mediaUrls } : {}),
      } as Json;

      if (STOP_KEYWORDS.test(bodyTrimmed)) {
        await applyPhoneLevelOptOut(supabase, {
          fromPhone: ev.from,
          source,
          sourceDetail: { externalId: ev.externalId, from: ev.from },
          occurredAt: ev.receivedAt,
          providerId: provider.providerId,
          surface: "stop",
        });
        const insertOutcome = await insertInboundMessage(supabase, {
          providerId: provider.providerId,
          externalId: ev.externalId,
          from: ev.from,
          to: ev.to,
          body: ev.body,
          contactId,
          propertyId,
          conversationId,
          metadata: { ...jsonObject(baseMetadata), keyword: "stop" } as Json,
        });
        if (insertOutcome.error) {
          await markWebhookEventError(
            supabase,
            provider.providerId,
            ev.externalId,
            insertOutcome.error.message,
          );
          return NextResponse.json(
            { error: "inbound message insert failed" },
            { status: 500 },
          );
        }
        await markWebhookEventProcessed(supabase, provider.providerId, ev.externalId);
        continue;
      }

      if (HELP_KEYWORDS.test(bodyTrimmed)) {
        if (contactId) {
          await recordConsentEvent(supabase, {
            contactId,
            channel: "sms",
            eventType: "help_request",
            source,
            sourceDetail: { externalId: ev.externalId, from: ev.from },
            occurredAt: ev.receivedAt,
          });
        }
        const insertOutcome = await insertInboundMessage(supabase, {
          providerId: provider.providerId,
          externalId: ev.externalId,
          from: ev.from,
          to: ev.to,
          body: ev.body,
          contactId,
          propertyId,
          conversationId,
          metadata: { ...jsonObject(baseMetadata), keyword: "help" } as Json,
        });
        if (insertOutcome.error) {
          await markWebhookEventError(
            supabase,
            provider.providerId,
            ev.externalId,
            insertOutcome.error.message,
          );
          return NextResponse.json(
            { error: "inbound message insert failed" },
            { status: 500 },
          );
        }
        await markWebhookEventProcessed(supabase, provider.providerId, ev.externalId);
        continue;
      }

      if (DNC_KEYWORDS.test(ev.body)) {
        await applyPhoneLevelOptOut(supabase, {
          fromPhone: ev.from,
          source,
          sourceDetail: {
            externalId: ev.externalId,
            from: ev.from,
            keyword: "dnc",
          },
          occurredAt: ev.receivedAt,
          providerId: provider.providerId,
          surface: "dnc",
        });
        if (propertyId) {
          await supabase
            .from("properties")
            .update({ outreach_dispo: "dnc" })
            .eq("id", propertyId);
        }
        const insertOutcome = await insertInboundMessage(supabase, {
          providerId: provider.providerId,
          externalId: ev.externalId,
          from: ev.from,
          to: ev.to,
          body: ev.body,
          contactId,
          propertyId,
          conversationId,
          metadata: { ...jsonObject(baseMetadata), keyword: "dnc" } as Json,
        });
        if (insertOutcome.error) {
          await markWebhookEventError(
            supabase,
            provider.providerId,
            ev.externalId,
            insertOutcome.error.message,
          );
          return NextResponse.json(
            { error: "inbound message insert failed" },
            { status: 500 },
          );
        }
        await markWebhookEventProcessed(supabase, provider.providerId, ev.externalId);
        continue;
      }

      if (WRONG_NUMBER_KEYWORDS.test(ev.body)) {
        if (propertyId) {
          await supabase
            .from("properties")
            .update({ outreach_dispo: "wrong_number" })
            .eq("id", propertyId);
          try {
            await pausePropertyEnrollments(supabase, {
              propertyId,
              reason: "inbound_reply",
            });
          } catch (e) {
            reportError(e, {
              tags: {
                surface: `${provider.providerId}_webhook_sequence_pause_wrong_number`,
              },
              extra: { propertyId, externalId: ev.externalId },
            });
          }
        }
        const insertOutcome = await insertInboundMessage(supabase, {
          providerId: provider.providerId,
          externalId: ev.externalId,
          from: ev.from,
          to: ev.to,
          body: ev.body,
          contactId,
          propertyId,
          conversationId,
          metadata: { ...jsonObject(baseMetadata), keyword: "wrong_number" } as Json,
        });
        if (insertOutcome.error) {
          await markWebhookEventError(
            supabase,
            provider.providerId,
            ev.externalId,
            insertOutcome.error.message,
          );
          return NextResponse.json(
            { error: "inbound message insert failed" },
            { status: 500 },
          );
        }
        await markWebhookEventProcessed(supabase, provider.providerId, ev.externalId);
        continue;
      }

      const insertOutcome = await insertInboundMessage(supabase, {
        providerId: provider.providerId,
        externalId: ev.externalId,
        from: ev.from,
        to: ev.to,
        body: ev.body,
        contactId,
        propertyId,
        conversationId,
        metadata: baseMetadata,
      });
      if (insertOutcome.error) {
        reportError(new Error(insertOutcome.error.message), {
          tags: { surface: `${provider.providerId}_webhook_inbound_insert` },
          extra: { externalId: ev.externalId, code: insertOutcome.error.code },
        });
        await markWebhookEventError(
          supabase,
          provider.providerId,
          ev.externalId,
          insertOutcome.error.message,
        );
        return NextResponse.json(
          { error: "inbound message insert failed" },
          { status: 500 },
        );
      }
      const inboundMessage = insertOutcome.message;

      if (!propertyId || !inboundMessage) {
        await markWebhookEventProcessed(supabase, provider.providerId, ev.externalId);
        continue;
      }

      const { data: cur } = await supabase
        .from("properties")
        .select("status")
        .eq("id", propertyId)
        .maybeSingle();

      if (cur?.status === "prospect" && ev.body) {
        let shouldQualify = false;
        if (process.env.SKIP_INTENT_GATE === "1") {
          shouldQualify = true;
        } else {
          try {
            const intent = await classifyReplyIntent(ev.body, new Anthropic());
            shouldQualify = intent === "positive";
          } catch (e) {
            reportError(e, {
              tags: { surface: `${provider.providerId}_webhook_classify_intent` },
              extra: { propertyId, externalId: ev.externalId },
            });
          }
        }

        if (shouldQualify) {
          const qOutcome = await qualifyProperty(
            supabase,
            propertyId,
            "system:inbound_reply",
          );
          if (qOutcome.status === "failed") {
            reportError(new Error(qOutcome.message), {
              tags: { surface: `${provider.providerId}_webhook_auto_qualify` },
              extra: { propertyId, externalId: ev.externalId },
            });
          }
        }
      }

      try {
        const { data: propRow } = await supabase
          .from("properties")
          .select("assigned_user_id, address")
          .eq("id", propertyId)
          .maybeSingle();
        const adminUserIds = propRow?.assigned_user_id
          ? []
          : await listAdminUserIds(supabase);
        const ownerNotificationAlreadySent =
          hasOwnerNotificationDispatchMarker(inboundMessage.metadata) ||
          (insertOutcome.duplicate &&
            !!propRow &&
            (await ownerNotificationExists(supabase, {
              propertyId,
              assignedUserId: propRow.assigned_user_id,
              adminUserIds,
              address: propRow.address,
              messageBody: ev.body,
            })));

        if (!ownerNotificationAlreadySent) {
          await dispatchOwnerMessageAdded(supabase, {
            propertyId,
            adminUserIds,
            messageBody: ev.body,
          });
          await updateInboundMessageMetadata(supabase, inboundMessage.id, {
            owner_notification_dispatched_at: new Date().toISOString(),
          });
        }
      } catch (e) {
        reportError(e, {
          tags: { surface: `${provider.providerId}_webhook_notification_dispatch` },
          extra: { propertyId, externalId: ev.externalId },
        });
      }

      try {
        await pausePropertyEnrollments(supabase, {
          propertyId,
          reason: "inbound_reply",
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: `${provider.providerId}_webhook_sequence_pause_inbound` },
          extra: { propertyId, externalId: ev.externalId },
        });
      }

      if (contactId) {
        try {
          await dispatchAiResponse(
            supabase,
            {
              propertyId,
              contactId,
              inboundBody: ev.body,
              conversationId:
                inboundMessage.conversation_id ?? conversationId ?? null,
              externalId: ev.externalId,
            },
            {
              anthropic: new Anthropic(),
            },
          );
        } catch (e) {
          reportError(e, {
            tags: { surface: `${provider.providerId}_webhook_ai_responder` },
            extra: { propertyId, externalId: ev.externalId },
          });
        }
      }

      await markWebhookEventProcessed(supabase, provider.providerId, ev.externalId);
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    reportError(e, { tags: { surface: "messaging_webhook_unexpected" } });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}

async function insertInboundMessage(
  supabase: SupabaseClient<Database>,
  input: {
    providerId: string;
    externalId: string;
    from: string;
    to: string;
    body: string;
    contactId: string | null;
    propertyId: string | null;
    conversationId: string | null;
    metadata: Json | null;
  },
): Promise<
  | { duplicate: false; error: null; message: InboundMessageRow }
  | { duplicate: true; error: null; message: InboundMessageRow | null }
  | { duplicate: false; error: { code?: string; message: string }; message: null }
> {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
      provider: input.providerId,
      external_id: input.externalId,
      from_address: normalizePhone(input.from) ?? input.from,
      to_address: normalizePhone(input.to) ?? input.to,
      body: input.body,
      contact_id: input.contactId,
      property_id: input.propertyId,
      conversation_id: input.conversationId,
      metadata: input.metadata,
    })
    .select("id, contact_id, property_id, conversation_id, metadata")
    .maybeSingle();
  if (!error && data) {
    return { duplicate: false, error: null, message: data };
  }
  if (error?.code === "23505") {
    return {
      duplicate: true,
      error: null,
      message: await loadInboundMessage(
        supabase,
        input.providerId,
        input.externalId,
      ),
    };
  }
  return {
    duplicate: false,
    error: error ?? { message: "failed to insert inbound message" },
    message: null,
  };
}

function jsonObject(value: Json): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasOwnerNotificationDispatchMarker(metadata: Json | null): boolean {
  const ownerNotificationDispatchedAt = jsonObject(metadata)
    .owner_notification_dispatched_at;
  return typeof ownerNotificationDispatchedAt === "string";
}

async function loadInboundMessage(
  supabase: SupabaseClient<Database>,
  providerId: string,
  externalId: string,
): Promise<InboundMessageRow | null> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, contact_id, property_id, conversation_id, metadata")
    .eq("channel", "sms")
    .eq("direction", "inbound")
    .eq("provider", providerId)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) {
    throw new Error(`loadInboundMessage: ${error.message}`);
  }
  return data;
}

async function updateInboundMessageMetadata(
  supabase: SupabaseClient<Database>,
  messageId: string,
  patch: Record<string, unknown>,
) {
  const { data: existingMessage, error: loadError } = await supabase
    .from("messages")
    .select("metadata")
    .eq("id", messageId)
    .single();
  if (loadError) {
    throw new Error(`updateInboundMessageMetadata load: ${loadError.message}`);
  }

  const { error } = await supabase
    .from("messages")
    .update({
      metadata: {
        ...jsonObject(existingMessage.metadata ?? null),
        ...patch,
      } as Json,
    })
    .eq("id", messageId);
  if (error) {
    throw new Error(`updateInboundMessageMetadata: ${error.message}`);
  }
}

async function ownerNotificationExists(
  supabase: SupabaseClient<Database>,
  input: {
    propertyId: string;
    assignedUserId: string | null;
    adminUserIds: readonly string[];
    address: string | null;
    messageBody: string;
  },
): Promise<boolean> {
  const recipients = input.assignedUserId
    ? [input.assignedUserId]
    : input.adminUserIds;
  if (recipients.length === 0) return false;

  const raw = input.messageBody.trim();
  const isUrl = /^\s*https?:\/\/\S+\s*$/.test(raw);
  const preview = raw && !isUrl ? raw.slice(0, 80) : null;
  const expectedBody = preview
    ? `Reply from ${input.address ?? "a property"}\n${preview}`
    : `Reply from ${input.address ?? "a property"}`;

  const { data, error } = await supabase
    .from("notifications")
    .select("user_id")
    .eq("event_type", "owner_message_added")
    .eq("entity_type", "property")
    .eq("entity_id", input.propertyId)
    .eq("title", "New SMS reply")
    .eq("body", expectedBody)
    .in("user_id", recipients);
  if (error) {
    throw new Error(`ownerNotificationExists: ${error.message}`);
  }

  return new Set((data ?? []).map((row) => row.user_id)).size === recipients.length;
}

async function reserveWebhookEvent(
  supabase: SupabaseClient<Database>,
  input: { provider: string; externalId: string; payload: Json },
): Promise<
  | { status: "reserved" }
  | { status: "skip" }
  | { status: "error"; message: string }
> {
  const { error } = await supabase.from("webhook_events").insert({
    provider: input.provider,
    event_type: "sms_inbound",
    external_id: input.externalId,
    signature_verified: true,
    processing_status: "pending",
    payload: input.payload,
  });
  if (!error) return { status: "reserved" };
  if (error.code !== "23505") return { status: "error", message: error.message };

  const { data: existing, error: existingError } = await supabase
    .from("webhook_events")
    .select("processing_status")
    .eq("provider", input.provider)
    .eq("event_type", "sms_inbound")
    .eq("external_id", input.externalId)
    .maybeSingle();
  if (existingError) return { status: "error", message: existingError.message };
  if (existing?.processing_status === "processed") return { status: "skip" };
  return { status: "reserved" };
}

async function markWebhookEventProcessed(
  supabase: SupabaseClient<Database>,
  providerId: string,
  externalId: string,
) {
  await supabase
    .from("webhook_events")
    .update({
      processing_status: "processed",
      processed_at: new Date().toISOString(),
    })
    .eq("provider", providerId)
    .eq("event_type", "sms_inbound")
    .eq("external_id", externalId);
}

async function markWebhookEventError(
  supabase: SupabaseClient<Database>,
  providerId: string,
  externalId: string,
  message: string,
) {
  await supabase
    .from("webhook_events")
    .update({
      processing_status: "error",
      processed_at: new Date().toISOString(),
      error_message: message,
    })
    .eq("provider", providerId)
    .eq("event_type", "sms_inbound")
    .eq("external_id", externalId);
}

async function applyPhoneLevelOptOut(
  supabase: SupabaseClient<Database>,
  input: {
    fromPhone: string;
    source: string;
    sourceDetail: Json;
    occurredAt: Date;
    providerId: string;
    surface: "stop" | "dnc";
  },
) {
  const contactIds = await loadContactIdsByPhone(supabase, input.fromPhone);
  for (const contactId of contactIds) {
    await recordConsentEvent(supabase, {
      contactId,
      channel: "sms",
      eventType: "opt_out",
      source: input.source,
      sourceDetail: input.sourceDetail,
      occurredAt: input.occurredAt,
    });
    await supabase
      .from("contacts")
      .update({
        sms_opted_out: true,
        sms_opted_out_at: input.occurredAt.toISOString(),
      })
      .eq("id", contactId);
    try {
      await pauseContactEnrollments(supabase, {
        contactId,
        reason: "consent_revoked",
        permanent: true,
      });
    } catch (e) {
      reportError(e, {
        tags: { surface: `${input.providerId}_webhook_sequence_pause_${input.surface}` },
        extra: { contactId, fromPhone: input.fromPhone },
      });
    }
  }
}

async function loadContactIdsByPhone(
  supabase: SupabaseClient<Database>,
  fromPhone: string,
): Promise<string[]> {
  const normalized = normalizePhone(fromPhone);
  if (!normalized) return [];

  const queries = await Promise.all([
    supabase.from("contacts").select("id").eq("phone_1", normalized).limit(20),
    supabase.from("contacts").select("id").eq("phone_2", normalized).limit(20),
    supabase.from("contacts").select("id").eq("phone_3", normalized).limit(20),
  ]);

  const ids = new Set<string>();
  for (const result of queries) {
    if (result.error) {
      throw new Error(`loadContactIdsByPhone: ${result.error.message}`);
    }
    for (const row of result.data ?? []) ids.add(row.id);
  }
  return Array.from(ids);
}
