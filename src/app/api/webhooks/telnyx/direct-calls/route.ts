import { NextResponse } from "next/server";

import { readTelnyxDirectSettings } from "@/lib/direct-calling/config";
import { verifyTelnyxSignature } from "@/lib/direct-calling/signature";
import { createSupabaseDirectCallStore } from "@/lib/direct-calling/store";
import { createDirectRecordingHandler } from "@/lib/direct-calling/recording";
import { createDirectCoachStarter } from "@/lib/direct-calling/coach";
import { telnyxDial, telnyxGetCallAlive, telnyxGetRecording, telnyxHangup, telnyxListActiveCalls } from "@/lib/direct-calling/telnyx";
import { processDirectCallWebhook } from "@/lib/direct-calling/webhook";
import { reportError } from "@/lib/errors/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Telnyx Voice API webhook for the direct-calling pilot. Auth is the Ed25519 signature alone.
 * The raw body must be read as text before any parsing: the signature covers the exact bytes.
 */
export async function POST(request: Request): Promise<Response> {
  const settings = readTelnyxDirectSettings();
  if (!settings) return NextResponse.json({ error: "unavailable" }, { status: 503 });

  const rawBody = await request.text();
  const verified = verifyTelnyxSignature({
    rawBody,
    signature: request.headers.get("telnyx-signature-ed25519"),
    timestamp: request.headers.get("telnyx-timestamp"),
    publicKeyBase64: settings.webhookPublicKey,
    nowMs: Date.now(),
  });
  if (!verified.ok) return NextResponse.json({ error: "invalid_signature" }, { status: 401 });

  try {
    const recordingSaved = createDirectRecordingHandler({ getRecording: (recordingId) => telnyxGetRecording(settings, recordingId) });
    const outcome = await processDirectCallWebhook(rawBody, {
      store: createSupabaseDirectCallStore(),
      dial: (params) => telnyxDial(settings, params),
      hangup: (callControlId, commandId) => telnyxHangup(settings, callControlId, commandId),
      getCall: (callControlId) => telnyxGetCallAlive(settings, callControlId),
      listActiveCalls: () => telnyxListActiveCalls(settings),
      now: () => new Date(),
      report: (error, tag) => reportError(error, { tags: { surface: tag } }),
      recordingSaved,
      coachConnected: createDirectCoachStarter({ settings }),
    });
    return NextResponse.json({ ok: true, result: outcome.result }, { status: outcome.status });
  } catch (error) {
    // Only a failure to persist the event or its transition reaches here: answer 500 so Telnyx
    // redelivers. Pending provider cleanup is durable and retried on its own, never a reason to 500.
    reportError(error, { tags: { surface: "direct_call_webhook" } });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
