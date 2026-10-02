import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { readTelnyxDirectSettings } from "@/lib/direct-calling/config";
import { telnyxGetRecording } from "@/lib/direct-calling/telnyx";
import { sweepDirectRecordingCaptures } from "@/lib/direct-calling/recording-sweep";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const settings = readTelnyxDirectSettings();
  if (!settings) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  try {
    const summary = await sweepDirectRecordingCaptures({
      admin: createAdminClient(),
      getRecording: (recordingId) => telnyxGetRecording(settings, recordingId),
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_direct_recording_sweep" } });
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}

export { handle as GET, handle as POST };
