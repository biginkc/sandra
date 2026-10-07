import { NextResponse } from "next/server";

import { getReplayHandshake } from "@/lib/messaging/replay-stub";

/**
 * Replay runner handshake. Exists ONLY when SMS_PROVIDER_STUB=1 (404 on every
 * normal deployment). Reports booleans and the Supabase host, never secrets.
 */
export async function GET() {
  let handshake;
  try {
    handshake = getReplayHandshake();
  } catch (error) {
    // Unsafe environment with SMS_PROVIDER_STUB=1: fail loudly, never 200/404.
    const { reportError } = await import("@/lib/errors/report");
    reportError(error, { tags: { surface: "replay_handshake" } });
    return NextResponse.json(
      { error: "replay stub misconfigured" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!handshake) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(handshake, { headers: { "Cache-Control": "no-store" } });
}
