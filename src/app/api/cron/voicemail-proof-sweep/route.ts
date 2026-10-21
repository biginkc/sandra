import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { supabaseProofCopyStore, sweepPendingProofCopies } from "@/lib/voicemail-drop/proof-copy";

/**
 * Vercel cron → `/api/cron/voicemail-proof-sweep` every 5 minutes. Retries
 * voicemail drop proof-of-delivery copies whose download failed (or never
 * recorded a result) while Drop Cowboy's link still works. Answers
 * `disabled` until the 20261021230000 migration's columns exist.
 */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Postgres undefined_column / PostgREST unknown column. */
function schemaMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not exist|could not find .*column|schema cache/i.test(message);
}

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const counts = await sweepPendingProofCopies(supabaseProofCopyStore(createAdminClient()), { limit: 3 });
    return NextResponse.json({ ok: true, counts });
  } catch (error) {
    if (schemaMissing(error)) return NextResponse.json({ ok: true, status: "disabled" });
    reportError(error, { tags: { surface: "voicemail_proof_sweep" } });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
