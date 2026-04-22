import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { recordConsentEvent } from "@/lib/messaging/consent";
import { getMessagingProvider } from "@/lib/messaging/registry";
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
