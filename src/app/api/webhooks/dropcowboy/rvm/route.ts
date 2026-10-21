import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
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
 * receipts); the body's `event` field picks which one verifies it.
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
