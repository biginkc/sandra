import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { processDueCleanups } from "@/lib/direct-calling/cleanup";
import { readTelnyxDirectSettings } from "@/lib/direct-calling/config";
import { signWatchdogCleanup } from "@/lib/direct-calling/watchdog";
import { telnyxGetCallAlive, telnyxHangup, telnyxListActiveCalls } from "@/lib/direct-calling/telnyx";
import { createSupabaseDirectCallStore } from "@/lib/direct-calling/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request): Promise<NextResponse> {
  const secret = (process.env.DIRECT_WATCHDOG_CLEANUP_SECRET ?? process.env.DIRECT_WATCHDOG_SECRET)?.trim();
  const timestamp = request.headers.get("x-sandra-watchdog-timestamp") ?? "";
  const signature = request.headers.get("x-sandra-watchdog-signature") ?? "";
  const body = await request.text();
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 30_000 || !validSignature(body, timestamp, signature, secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let input: { callId?: unknown; sessionId?: unknown };
  try { input = JSON.parse(body) as { callId?: unknown; sessionId?: unknown } } catch { return NextResponse.json({ error: "invalid_request" }, { status: 400 }) }
  if (typeof input.callId !== "string" || !UUID.test(input.callId) || typeof input.sessionId !== "string" || !UUID.test(input.sessionId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const settings = readTelnyxDirectSettings();
  if (!settings) return NextResponse.json({ error: "watchdog_unavailable" }, { status: 503 });
  const store = createSupabaseDirectCallStore();
  const row = await store.findById(input.callId.toLowerCase());
  if (!row || row.browser_watchdog_session_id !== input.sessionId || !row.browser_watchdog_claimed_at || ["ended", "failed", "ending"].includes(row.status)) return NextResponse.json({ ok: true, ignored: true });
  const legs = [row.browser_leg_id, row.seller_leg_id].filter((leg): leg is string => Boolean(leg)).map((legId) => ({ kind: "leg" as const, legId }));
  const moved = await store.updateIfStatus(row.id, ["browser_connecting", "seller_dialing", "connected"], { status: "ending", failure_reason: "browser_watchdog_expired" }, legs);
  if (!moved) return NextResponse.json({ ok: true, ignored: true });
  await processDueCleanups({
    store,
    hangup: (leg, commandId) => telnyxHangup(settings, leg, commandId),
    getCall: (leg) => telnyxGetCallAlive(settings, leg),
    listActiveCalls: () => telnyxListActiveCalls(settings),
    now: () => new Date(),
    report: () => undefined,
  }, row.operator_user_id, 4);
  return NextResponse.json({ ok: true, expired: true });
}

function validSignature(body: string, timestamp: string, provided: string, secret: string): boolean {
  const expected = signWatchdogCleanup(body, timestamp, secret);
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}
