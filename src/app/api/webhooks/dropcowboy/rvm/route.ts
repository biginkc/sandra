import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleDropStatusEvent, supabaseDropStatusStore } from "@/lib/voicemail-drop/status-updates";
import { parseDropCowboyStatusWebhook, verifyDropCowboySignature } from "@/lib/voicemail-drop/webhook";

export const runtime = "nodejs";

/** Signed Drop Cowboy webhook: contact.rvm.status and contact.rvm.receipt. */
export async function POST(request: Request) {
  const secret = process.env.DROPCOWBOY_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const rawBody = await request.text();
  const check = verifyDropCowboySignature(secret, rawBody, request.headers);
  if (!check.valid) return NextResponse.json({ error: "invalid_signature" }, { status: 401 });

  let event;
  try {
    event = parseDropCowboyStatusWebhook(rawBody);
  } catch (error) {
    reportError(error, { tags: { surface: "dropcowboy_rvm_webhook_parse" } });
    return NextResponse.json({ error: "unrecognized_payload" }, { status: 400 });
  }

  try {
    const outcome = await handleDropStatusEvent(supabaseDropStatusStore(createAdminClient()), event);
    return NextResponse.json({ ok: true, outcome });
  } catch (error) {
    reportError(error, { tags: { surface: "dropcowboy_rvm_webhook" } });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
