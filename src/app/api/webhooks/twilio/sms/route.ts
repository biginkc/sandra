import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import Anthropic from "@anthropic-ai/sdk";

import { listAdminUserIds } from "@/lib/auth/admins";
import { dispatchAiResponse } from "@/lib/ai-responder/dispatch";
import { reportError } from "@/lib/errors/report";
import { classifyReplyIntent } from "@/lib/leads/classify-reply-intent";
import { qualifyProperty } from "@/lib/leads/qualify";
import { recordConsentEvent } from "@/lib/messaging/consent";
import { getMessagingProvider } from "@/lib/messaging/registry";
import { dispatchOwnerMessageAdded } from "@/lib/notifications/dispatch";
import {
  pauseContactEnrollments,
  pausePropertyEnrollments,
} from "@/lib/sequences/enrollment";
import type { Database, Json } from "@/lib/supabase/types";

/**
 * Twilio inbound-SMS webhook.
 *
 * Mirrors the DialPad route 1:1 except for two provider-specific bits:
 *   - The full request URL is passed to `verifyWebhookSignature` because
 *     Twilio's HMAC-SHA1 scheme folds the URL into the canonical string.
 *   - Error tags are scoped to `twilio_webhook_*` so logs disambiguate.
 *
 * The actual provider used at runtime is whatever `MESSAGING_PROVIDER`
 * resolves to via `getMessagingProvider()`. This route exists because
 * Twilio Console configures a fixed webhook URL per number; we serve it
 * here. The body of the handler is provider-agnostic.
 *
 * Follow-up: factor the shared inbound logic into a helper so dialpad +
 * twilio routes are thin wrappers. Deferred until both providers prove
 * stable in parallel.
 *
 * Flow:
 *   1. Read raw body (signature needs bytes, not parsed form).
 *   2. Provider.verifyWebhookSignature(rawBody, headers, fullUrl) — 401
 *      on mismatch.
 *   3. Persist a `webhook_events` row; unique (provider, event_type,
 *      external_id) gives exactly-once processing on retries.
 *   4. STOP/HELP/DNC/wrong-number routing, otherwise persist as inbound
 *      message + downstream side effects (qualify, notify, AI responder).
 *
 * Replies 200 after a valid signature even on downstream DB errors so
 * Twilio stops retrying. The error is logged for reconciliation.
 */

const STOP_KEYWORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|opt out|opt-out|remove)\s*$/i;
const HELP_KEYWORDS = /^\s*(help|info|support)\s*$/i;
const DNC_KEYWORDS = /do not (call|text|contact|reach out|message)|don'?t (call|text|contact|reach out|message)|stop (texting|calling|contacting) me|take me off|no more (texts|messages|calls)|remove me from|stop reaching out/i;
const WRONG_NUMBER_KEYWORDS = /wrong number|wrong person|not the owner|don'?t own|dont own|no longer own/i;

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

export async function POST(request: Request) {
  try {
    const provider = await getMessagingProvider();
    if (!provider) {
      return NextResponse.json(
        { error: "Messaging provider not configured" },
        { status: 503 },
      );
    }

    const rawBody = await request.text();

    // Build the canonical URL exactly as Twilio saw it.
    const fullUrl = new URL(
      request.url,
      `https://${request.headers.get("host") ?? "example.invalid"}`,
    ).toString();

    if (!provider.verifyWebhookSignature(rawBody, request.headers, fullUrl)) {
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 },
      );
    }

    let events;
    try {
      events = provider.parseInboundWebhook(rawBody);
    } catch (e) {
      reportError(e, { tags: { surface: "twilio_webhook_parse" } });
      return NextResponse.json(
        { error: "Unrecognized payload" },
        { status: 400 },
      );
    }

    const supabase = createServiceRoleClient();

    for (const ev of events) {
      const { error: dupeError } = await supabase
        .from("webhook_events")
        .insert({
          provider: provider.providerId,
          event_type: "sms_inbound",
          external_id: ev.externalId,
          signature_verified: true,
          payload: ev.raw as Json,
        });
      if (dupeError) {
        if (dupeError.code === "23505") continue;
        reportError(new Error(dupeError.message), {
          tags: { surface: "twilio_webhook_events_insert" },
          extra: { externalId: ev.externalId },
        });
      }

      const { data: contact } = await supabase
        .from("contacts")
        .select("id")
        .eq("phone_1", ev.from)
        .maybeSingle();
      const contactId = contact?.id ?? null;

      const bodyTrimmed = ev.body.trim();

      if (STOP_KEYWORDS.test(bodyTrimmed)) {
        if (contactId) {
          await recordConsentEvent(supabase, {
            contactId,
            channel: "sms",
            eventType: "opt_out",
            source: "twilio_inbound_webhook",
            sourceDetail: { externalId: ev.externalId, from: ev.from },
            occurredAt: ev.receivedAt,
          });
          await supabase
            .from("contacts")
            .update({
              sms_opted_out: true,
              sms_opted_out_at: ev.receivedAt.toISOString(),
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
              tags: { surface: "twilio_webhook_sequence_pause_stop" },
              extra: { contactId, externalId: ev.externalId },
            });
          }
        }
        await supabase.from("messages").insert({
          channel: "sms",
          direction: "inbound",
          status: "received",
          provider: provider.providerId,
          external_id: ev.externalId,
          from_address: ev.from,
          to_address: ev.to,
          body: ev.body,
          contact_id: contactId,
          metadata: { keyword: "stop" } as Json,
        });
        continue;
      }

      if (HELP_KEYWORDS.test(bodyTrimmed)) {
        if (contactId) {
          await recordConsentEvent(supabase, {
            contactId,
            channel: "sms",
            eventType: "help_request",
            source: "twilio_inbound_webhook",
            sourceDetail: { externalId: ev.externalId, from: ev.from },
            occurredAt: ev.receivedAt,
          });
        }
        await supabase.from("messages").insert({
          channel: "sms",
          direction: "inbound",
          status: "received",
          provider: provider.providerId,
          external_id: ev.externalId,
          from_address: ev.from,
          to_address: ev.to,
          body: ev.body,
          contact_id: contactId,
          metadata: { keyword: "help" } as Json,
        });
        continue;
      }

      if (DNC_KEYWORDS.test(ev.body)) {
        let dncPropertyId: string | null = null;
        if (contactId) {
          const { data: recentOutbound } = await supabase
            .from("messages")
            .select("property_id")
            .eq("contact_id", contactId)
            .eq("direction", "outbound")
            .not("property_id", "is", null)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          dncPropertyId = recentOutbound?.property_id ?? null;

          await recordConsentEvent(supabase, {
            contactId,
            channel: "sms",
            eventType: "opt_out",
            source: "twilio_inbound_webhook",
            sourceDetail: { externalId: ev.externalId, from: ev.from, keyword: "dnc" },
            occurredAt: ev.receivedAt,
          });
          await supabase
            .from("contacts")
            .update({ sms_opted_out: true, sms_opted_out_at: ev.receivedAt.toISOString() })
            .eq("id", contactId);
          try {
            await pauseContactEnrollments(supabase, {
              contactId,
              reason: "consent_revoked",
              permanent: true,
            });
          } catch (e) {
            reportError(e, {
              tags: { surface: "twilio_webhook_sequence_pause_dnc" },
              extra: { contactId, externalId: ev.externalId },
            });
          }
        }
        if (dncPropertyId) {
          await supabase
            .from("properties")
            .update({ outreach_dispo: "dnc" })
            .eq("id", dncPropertyId);
        }
        await supabase.from("messages").insert({
          channel: "sms",
          direction: "inbound",
          status: "received",
          provider: provider.providerId,
          external_id: ev.externalId,
          from_address: ev.from,
          to_address: ev.to,
          body: ev.body,
          contact_id: contactId,
          property_id: dncPropertyId,
          metadata: { keyword: "dnc" } as Json,
        });
        continue;
      }

      if (WRONG_NUMBER_KEYWORDS.test(ev.body)) {
        let wrongNumPropertyId: string | null = null;
        if (contactId) {
          const { data: recentOutbound } = await supabase
            .from("messages")
            .select("property_id")
            .eq("contact_id", contactId)
            .eq("direction", "outbound")
            .not("property_id", "is", null)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          wrongNumPropertyId = recentOutbound?.property_id ?? null;
        }
        if (wrongNumPropertyId) {
          await supabase
            .from("properties")
            .update({ outreach_dispo: "wrong_number" })
            .eq("id", wrongNumPropertyId);
          try {
            await pausePropertyEnrollments(supabase, {
              propertyId: wrongNumPropertyId,
              reason: "inbound_reply",
            });
          } catch (e) {
            reportError(e, {
              tags: { surface: "twilio_webhook_sequence_pause_wrong_number" },
              extra: { propertyId: wrongNumPropertyId, externalId: ev.externalId },
            });
          }
        }
        await supabase.from("messages").insert({
          channel: "sms",
          direction: "inbound",
          status: "received",
          provider: provider.providerId,
          external_id: ev.externalId,
          from_address: ev.from,
          to_address: ev.to,
          body: ev.body,
          contact_id: contactId,
          property_id: wrongNumPropertyId,
          metadata: { keyword: "wrong_number" } as Json,
        });
        continue;
      }

      let propertyId: string | null = null;
      if (contactId) {
        const { data: recentOutbound } = await supabase
          .from("messages")
          .select("property_id")
          .eq("contact_id", contactId)
          .eq("direction", "outbound")
          .not("property_id", "is", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        propertyId = recentOutbound?.property_id ?? null;
      }

      const { error: insertError } = await supabase
        .from("messages")
        .insert({
          channel: "sms",
          direction: "inbound",
          status: "received",
          provider: provider.providerId,
          external_id: ev.externalId,
          from_address: ev.from,
          to_address: ev.to,
          body: ev.body,
          contact_id: contactId,
          property_id: propertyId,
          metadata: ev.mediaUrls
            ? ({ mediaUrls: ev.mediaUrls } as Json)
            : null,
        });
      if (insertError) {
        reportError(new Error(insertError.message), {
          tags: { surface: "twilio_webhook_inbound_insert" },
          extra: { externalId: ev.externalId, code: insertError.code },
        });
      }

      if (propertyId) {
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
                tags: { surface: "twilio_webhook_classify_intent" },
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
                tags: { surface: "twilio_webhook_auto_qualify" },
                extra: { propertyId, externalId: ev.externalId },
              });
            }
          }
        }

        try {
          const { data: propRow } = await supabase
            .from("properties")
            .select("assigned_user_id")
            .eq("id", propertyId)
            .maybeSingle();
          const adminUserIds = propRow?.assigned_user_id
            ? []
            : await listAdminUserIds(supabase);
          await dispatchOwnerMessageAdded(supabase, {
            propertyId,
            adminUserIds,
            messageBody: ev.body,
          });
        } catch (e) {
          reportError(e, {
            tags: { surface: "twilio_webhook_notification_dispatch" },
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
            tags: { surface: "twilio_webhook_sequence_pause_inbound" },
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
              },
              {
                anthropic: new Anthropic(),
              },
            );
          } catch (e) {
            reportError(e, {
              tags: { surface: "twilio_webhook_ai_responder" },
              extra: { propertyId, externalId: ev.externalId },
            });
          }
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    reportError(e, { tags: { surface: "twilio_webhook_unexpected" } });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}
