import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleDropCallback, supabaseDropStatusStore } from "@/lib/voicemail-drop/status-updates";
import { parseDropCowboyCallback } from "@/lib/voicemail-drop/webhook";

export const runtime = "nodejs";

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Drop Cowboy callback_url (unsigned, single attempt). Auth is the secret path segment. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ secret: string }> },
) {
  const expected = process.env.DROPCOWBOY_CALLBACK_SECRET;
  if (!expected) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { secret } = await params;
  if (!secret || !secretMatches(secret, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let event;
  try {
    event = parseDropCowboyCallback(await request.text());
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await handleDropCallback(supabaseDropStatusStore(createAdminClient()), event);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    reportError(error, { tags: { surface: "dropcowboy_rvm_callback" } });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
