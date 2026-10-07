import { NextResponse } from "next/server";

import { getReplayHandshake } from "@/lib/messaging/replay-stub";

/**
 * Replay runner handshake. Exists ONLY when SMS_PROVIDER_STUB=1 (404 on every
 * normal deployment). Reports booleans and the Supabase host, never secrets.
 */
export async function GET() {
  const handshake = getReplayHandshake();
  if (!handshake) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(handshake, { headers: { "Cache-Control": "no-store" } });
}
