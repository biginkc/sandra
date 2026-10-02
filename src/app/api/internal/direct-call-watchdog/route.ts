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
// Keep one callback bounded while still working an unresolved-Dial row and both
// known legs before the next durable claim. Four listing pages plus two legs at
// this deadline stays below the fifteen-second claim lease.
const WATCHDOG_PROVIDER_TIMEOUT_MS = 2_000;

export async function POST(request: Request): Promise<NextResponse> {
  const secret = (process.env.DIRECT_WATCHDOG_CLEANUP_SECRET ?? process.env.DIRECT_WATCHDOG_SECRET)?.trim();
  const timestamp = request.headers.get("x-sandra-watchdog-timestamp") ?? "";
  const signature = request.headers.get("x-sandra-watchdog-signature") ?? "";
  const body = await request.text();
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 30_000 || !validSignature(body, timestamp, signature, secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let input: { callId?: unknown; sessionId?: unknown };
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    input = parsed as { callId?: unknown; sessionId?: unknown };
  } catch { return NextResponse.json({ error: "invalid_request" }, { status: 400 }) }
  if (typeof input.callId !== "string" || !UUID.test(input.callId) || typeof input.sessionId !== "string" || !UUID.test(input.sessionId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const settings = readTelnyxDirectSettings();
  if (!settings) return NextResponse.json({ error: "watchdog_unavailable" }, { status: 503 });
  const store = createSupabaseDirectCallStore();
  const row = await store.findById(input.callId.toLowerCase());
  if (!row || row.browser_watchdog_session_id !== input.sessionId || !row.browser_watchdog_claimed_at) return NextResponse.json({ ok: true, ignored: true });
  // A terminal call is eligible only while a durable cleanup obligation remains. The
  // watchdog claim function applies the same predicate; this second check keeps a stale
  // callback from touching a fully settled terminal row and never reopens its status.
  if (["ended", "failed"].includes(row.status) && (await store.openCleanupsForCall(row.id)).length === 0) {
    return NextResponse.json({ ok: true, ignored: true });
  }
  const legs = [row.browser_leg_id, row.seller_leg_id].filter((leg): leg is string => Boolean(leg)).map((legId) => ({ kind: "leg" as const, legId }));
  if (["browser_connecting", "seller_dialing", "connected"].includes(row.status)) {
    const moved = await store.updateIfStatus(row.id, ["browser_connecting", "seller_dialing", "connected"], { status: "ending", failure_reason: "browser_watchdog_expired" }, legs);
    if (!moved) return NextResponse.json({ ok: true, ignored: true });
  }
  await processDueCleanups({
    store,
    hangup: (leg, commandId) => telnyxHangup(settings, leg, commandId, { timeoutMs: WATCHDOG_PROVIDER_TIMEOUT_MS }),
    getCall: (leg) => telnyxGetCallAlive(settings, leg, { timeoutMs: WATCHDOG_PROVIDER_TIMEOUT_MS }),
    listActiveCalls: () => telnyxListActiveCalls(settings, { timeoutMs: WATCHDOG_PROVIDER_TIMEOUT_MS }),
    now: () => new Date(),
    report: () => undefined,
  }, row.operator_user_id, 3);
  // A resolved unresolved-Dial or the final confirmed leg has no webhook left to
  // move an ending row terminal. Reuse the same CAS transition after the shared
  // cleanup core confirms every obligation; an open row leaves ending durable for
  // the next watchdog claim.
  if ((await store.openCleanupsForCall(row.id)).length === 0) {
    await store.updateIfStatus(row.id, ["ending"], { status: "ended", ended_at: new Date().toISOString() });
  }
  return NextResponse.json({ ok: true, expired: true });
}

function validSignature(body: string, timestamp: string, provided: string, secret: string): boolean {
  const expected = signWatchdogCleanup(body, timestamp, secret);
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}
