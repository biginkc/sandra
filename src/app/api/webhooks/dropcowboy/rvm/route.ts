import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  DROPCOWBOY_CALL_RINGING_EVENT,
  handleDropCowboyInboundCall,
  parseDropCowboyCallEvent,
  supabaseInboundCallPauseStore,
} from "@/lib/voicemail-drop/inbound-call";
import { copyDropProof, supabaseProofCopyStore } from "@/lib/voicemail-drop/proof-copy";
import { handleDropStatusEvent, supabaseDropStatusStore } from "@/lib/voicemail-drop/status-updates";
import {
  parseDropCowboyStatusWebhook,
  selectDropCowboyWebhookSecret,
  UnsupportedDropCowboyEventError,
  verifyDropCowboySignature,
} from "@/lib/voicemail-drop/webhook";

export const runtime = "nodejs";
/** A receipt downloads the proof recording (15s timeout) inside the request. */
export const maxDuration = 60;

/**
 * Signed Drop Cowboy webhook: contact.rvm.status and contact.rvm.receipt.
 * Each event type's subscription has its own signing secret
 * (DROPCOWBOY_WEBHOOK_SECRET for status, DROPCOWBOY_RECEIPT_WEBHOOK_SECRET for
 * receipts, DROPCOWBOY_CALL_WEBHOOK_SECRET for contact.call.ringing); the
 * body's `event` field picks which one verifies it. contact.call.ringing
 * carries the real caller of a call-back to the drop line and pauses their
 * drips (the forward to Norma hides it).
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const selection = selectDropCowboyWebhookSecret(rawBody);
  if (selection.kind === "unparseable") {
    return NextResponse.json({ error: "unrecognized_payload" }, { status: 400 });
  }
  if (selection.kind === "unsupported") {
    // Acknowledge event types Sandra doesn't handle (nothing is read from
    // them): Drop Cowboy pauses an endpoint after 5 non-retriable rejections
    // in a row and drops events while paused.
    console.info(`[dropcowboy_rvm_webhook] ignored unsupported event ${selection.event.slice(0, 64)}`);
    return NextResponse.json({ ok: true, outcome: "ignored" });
  }
  if (!selection.secret) {
    reportError(new Error(`dropcowboy webhook: ${selection.envName} is not set for ${selection.event}`), {
      tags: { surface: "dropcowboy_rvm_webhook_secret" },
    });
    return NextResponse.json({ error: "not_configured" }, { status: 401 });
  }
  const check = verifyDropCowboySignature(selection.secret, rawBody, request.headers);
  if (!check.valid) return NextResponse.json({ error: "invalid_signature" }, { status: 401 });

  if (selection.event === DROPCOWBOY_CALL_RINGING_EVENT) return handleInboundCall(rawBody);

  let event;
  try {
    event = parseDropCowboyStatusWebhook(rawBody);
  } catch (error) {
    // Acknowledge event types Sandra doesn't handle: Drop Cowboy pauses an
    // endpoint after 5 non-retriable rejections in a row and drops events
    // while paused.
    if (error instanceof UnsupportedDropCowboyEventError) {
      console.info(`[dropcowboy_rvm_webhook] ignored unsupported event ${error.eventType}`);
      return NextResponse.json({ ok: true, outcome: "ignored" });
    }
    reportError(error, { tags: { surface: "dropcowboy_rvm_webhook_parse" } });
    return NextResponse.json({ error: "unrecognized_payload" }, { status: 400 });
  }

  try {
    const admin = createAdminClient();
    const outcome = await handleDropStatusEvent(supabaseDropStatusStore(admin), event, new Date(), {
      onProofUrl: (dropRowId) => copyDropProof(supabaseProofCopyStore(admin), dropRowId),
    });
    return NextResponse.json({ ok: true, outcome });
  } catch (error) {
    reportError(error, { tags: { surface: "dropcowboy_rvm_webhook" } });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

async function handleInboundCall(rawBody: string) {
  let event;
  try {
    event = parseDropCowboyCallEvent(rawBody);
  } catch (error) {
    reportError(error, { tags: { surface: "dropcowboy_call_webhook_parse" } });
    return NextResponse.json({ error: "unrecognized_payload" }, { status: 400 });
  }
  const phoneLineId = process.env.DROPCOWBOY_PHONE_LINE_ID?.trim();
  if (!phoneLineId) {
    reportError(new Error("dropcowboy webhook: DROPCOWBOY_PHONE_LINE_ID is not set for contact.call.ringing"), {
      tags: { surface: "dropcowboy_call_webhook_config" },
    });
    return NextResponse.json({ error: "not_configured" }, { status: 500 });
  }
  try {
    const admin = createAdminClient();
    const outcome = await handleDropCowboyInboundCall(
      supabaseDropStatusStore(admin),
      supabaseInboundCallPauseStore(admin),
      event,
      phoneLineId,
    );
    return NextResponse.json({ ok: true, outcome });
  } catch (error) {
    reportError(error, { tags: { surface: "dropcowboy_call_webhook" } });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
