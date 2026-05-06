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
 * Dialpad inbound-SMS webhook.
 *
 * Middleware (`src/lib/supabase/middleware.ts`) whitelists `/api/webhooks`
 * as public so no user session is required — authenticity comes from
 * the provider's HMAC signature on the raw body. Service-role key is
 * used here so the handler can write to `webhook_events`, `messages`,
 * `consent_events`, and `contacts` without RLS in the way.
 *
 * Flow:
 *   1. Read raw body (signature needs bytes, not parsed JSON).
 *   2. Provider.verifyWebhookSignature(...) — 401 on mismatch.
 *   3. Persist a `webhook_events` row; unique (provider, event_type,
 *      external_id) gives us exactly-once processing on Dialpad retries.
 *   4. For each parsed event: STOP/HELP handling, otherwise persist as
 *      an inbound `messages` row.
 *
 * Always replies 200 after a successful signature check — even on
 * downstream DB errors — to stop Dialpad from retrying. The error is
 * logged to Sentry / the `webhook_events.error_message` column for
 * later reconciliation instead.
 */

const STOP_KEYWORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|opt out|opt-out|remove)\s*$/i;
const HELP_KEYWORDS = /^\s*(help|info|support)\s*$/i;

// Conversational DNC phrases — not caught by STOP_KEYWORDS (which anchors to
// exact-match only). These carry the same TCPA suppression obligation.
const DNC_KEYWORDS = /do not (call|text|contact|reach out|message)|don'?t (call|text|contact|reach out|message)|stop (texting|calling|contacting) me|take me off|no more (texts|messages|calls)|remove me from|stop reaching out/i;

// Wrong-number phrases — property needs a new number; not a TCPA opt-out.
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
    const provider = getMessagingProvider();
    if (!provider) {
      return NextResponse.json(
        { error: "Messaging provider not configured" },
        { status: 503 },
      );
    }

    const rawBody = await request.text();

    if (!provider.verifyWebhookSignature(rawBody, request.headers)) {
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 },
      );
    }

    let events;
    try {
      events = provider.parseInboundWebhook(rawBody);
    } catch (e) {
      // Bad payload shape — 400 so Dialpad doesn't retry forever.
      reportError(e, { tags: { surface: "dialpad_webhook_parse" } });
      return NextResponse.json(
        { error: "Unrecognized payload" },
        { status: 400 },
      );
    }

    const supabase = createServiceRoleClient();

    for (const ev of events) {
      // Idempotency — unique (provider, event_type, external_id). Insert
      // can fail with 23505 on a retry; that's the signal to skip
      // downstream work for this event.
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
        // 23505 = unique_violation → duplicate delivery, skip silently.
        if (dupeError.code === "23505") continue;
        // Other DB errors are logged but don't crash the handler — we
        // still process the event in-memory so behavior is best-effort.
        reportError(new Error(dupeError.message), {
          tags: { surface: "dialpad_webhook_events_insert" },
          extra: { externalId: ev.externalId },
        });
      }

      // Match the inbound `from` phone to a contact, by phone_1.
      const { data: contact } = await supabase
        .from("contacts")
        .select("id")
        .eq("phone_1", ev.from)
        .maybeSingle();
      const contactId = contact?.id ?? null;

      const bodyTrimmed = ev.body.trim();

      // STOP — propagate opt-out to consent log AND the fast-path boolean.
      if (STOP_KEYWORDS.test(bodyTrimmed)) {
        if (contactId) {
          await recordConsentEvent(supabase, {
            contactId,
            channel: "sms",
            eventType: "opt_out",
            source: "dialpad_inbound_webhook",
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
          // Flip every active sequence enrollment for this contact to
          // opted_out. Permanent — even a resume later would re-hit the
          // send_sms consent check and abort.
          try {
            await pauseContactEnrollments(supabase, {
              contactId,
              reason: "consent_revoked",
              permanent: true,
            });
          } catch (e) {
            reportError(e, {
              tags: { surface: "dialpad_webhook_sequence_pause_stop" },
              extra: { contactId, externalId: ev.externalId },
            });
          }
        }
        // Still persist the message for audit even though it's a STOP.
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

      // HELP — log the event, persist the message, don't mutate consent.
      if (HELP_KEYWORDS.test(bodyTrimmed)) {
        if (contactId) {
          await recordConsentEvent(supabase, {
            contactId,
            channel: "sms",
            eventType: "help_request",
            source: "dialpad_inbound_webhook",
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

      // DNC — conversational "do not call/text me" phrases. Same TCPA
      // suppression obligation as STOP; we just log it as opt_out and also
      // stamp outreach_dispo = 'dnc' on the property so the cockpit shows it.
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
            source: "dialpad_inbound_webhook",
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
              tags: { surface: "dialpad_webhook_sequence_pause_dnc" },
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

      // WRONG_NUMBER — seller says this isn't their property or number.
      // Marks the property as needing a new number; pauses sequences.
      // Not a TCPA opt-out — consent state is untouched.
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
              tags: { surface: "dialpad_webhook_sequence_pause_wrong_number" },
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

      // Otherwise: regular inbound message. Thread it to the contact's
      // most recent outbound property for continuity.
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
          tags: { surface: "dialpad_webhook_inbound_insert" },
          extra: { externalId: ev.externalId, code: insertError.code },
        });
      }

      // Auto-qualify: only promote a prospect to new_lead when the reply
      // shows genuine seller interest. Neutral ("who is this?") and
      // negative ("not interested") replies leave the property as a
      // prospect. Fails CLOSED on classifier error — false positives are
      // the bug we're fixing, so erring on the side of "stay a prospect"
      // matches intent. The VA can promote manually from the lead page.
      if (propertyId) {
        // Skip the AI call entirely if the property isn't currently a
        // prospect (Dialpad retries, continuing conversations on already-
        // qualified leads). qualifyProperty would no-op anyway, but this
        // saves the Haiku call.
        const { data: cur } = await supabase
          .from("properties")
          .select("status")
          .eq("id", propertyId)
          .maybeSingle();

        if (cur?.status === "prospect" && ev.body) {
          let shouldQualify = false;
          // SKIP_INTENT_GATE bypass: e2e Playwright runs without an
          // Anthropic API key. Set in .github/workflows/e2e.yml so the
          // downstream qualify path is exercised in CI; the classifier
          // itself is unit-tested directly in classify-reply-intent.test.ts.
          if (process.env.SKIP_INTENT_GATE === "1") {
            shouldQualify = true;
          } else {
            try {
              const intent = await classifyReplyIntent(ev.body, new Anthropic());
              shouldQualify = intent === "positive";
            } catch (e) {
              // Classification error — fail closed. Property stays a prospect;
              // VA can promote manually if they judge the reply as a real lead.
              reportError(e, {
                tags: { surface: "dialpad_webhook_classify_intent" },
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
                tags: { surface: "dialpad_webhook_auto_qualify" },
                extra: { propertyId, externalId: ev.externalId },
              });
            }
          }
        }

        // Fire owner_message_added notification. Assignee wins over
        // admin fallback (Feature 7 decision #6) — we look up the
        // assigned user first and only resolve admins when unassigned,
        // saving an auth.admin.listUsers round-trip on the hot path.
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
          // Notifications are best-effort — never fail the webhook.
          reportError(e, {
            tags: { surface: "dialpad_webhook_notification_dispatch" },
            extra: { propertyId, externalId: ev.externalId },
          });
        }

        // Pause any active sequence enrollments for this property —
        // a seller reply moves the conversation to a human, and the
        // VA can resume the sequence later if they want to.
        try {
          await pausePropertyEnrollments(supabase, {
            propertyId,
            reason: "inbound_reply",
          });
        } catch (e) {
          reportError(e, {
            tags: { surface: "dialpad_webhook_sequence_pause_inbound" },
            extra: { propertyId, externalId: ev.externalId },
          });
        }

        // AI responder (Feature 6) — consider a first-touch reply.
        // Returns skip/escalate/sent; no config or any gate failure
        // silently short-circuits. Dispatcher swallows its own errors
        // and flags `needs_human_attention` on escalation, so the
        // webhook doesn't need to care about the outcome for the HTTP
        // response. Always returns 200 to Dialpad regardless.
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
              tags: { surface: "dialpad_webhook_ai_responder" },
              extra: { propertyId, externalId: ev.externalId },
            });
          }
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    reportError(e, { tags: { surface: "dialpad_webhook_unexpected" } });
    // Return 500 so Dialpad retries — we want to be sure we didn't lose
    // the event due to an infrastructure blip. Idempotency handles the
    // replay.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}
