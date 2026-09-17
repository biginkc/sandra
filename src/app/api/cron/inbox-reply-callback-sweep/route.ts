import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types";

export const maxDuration = 60;

const BATCH_LIMIT = 100;

// `public.inbox_reply_sweep_unmatched_callbacks` (experiments/inbox-reply-send/
// callback.sql) is not yet reflected in the generated Database types — same
// overlay idiom as ../../webhooks/sendillo/reply-status/route.ts.
type SweepDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Functions"> & {
    Functions: Database["public"]["Functions"] & {
      inbox_reply_sweep_unmatched_callbacks: {
        Args: { batch_limit: number };
        Returns: Json;
      };
    };
  };
};
type SweepClient = Pick<SupabaseClient<SweepDatabase>, "rpc">;

/**
 * Durable recovery sweep for the reply-callback ingress
 * (../../webhooks/sendillo/reply-status/route.ts): the ingress webhook and
 * the wrapper's own drain-first step are the fast path (Astra fix-1 — a
 * held callback is drained the moment a SECOND callback for the same
 * reference arrives on the matched path). This cron closes the remaining
 * gap — a callback held before persist() that never gets a second callback
 * at all — by periodically draining any unmatched_callbacks row whose
 * reference now matches a persisted attempt. Mirrors the ARCHITECTURE of
 * ../sendillo-status-reconciliation/route.ts (CRON_SECRET bearer auth,
 * service-role client, a bounded batch per invocation) — not its code or
 * its table; this lane's dedup/state lives entirely in
 * inbox_reply_send.unmatched_callbacks/callback_receipts, never
 * public.webhook_events.
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase: SweepClient = createAdminClient();
    const { data, error } = await supabase.rpc("inbox_reply_sweep_unmatched_callbacks", { batch_limit: BATCH_LIMIT });
    if (error) {
      reportError(new Error(error.message), { tags: { surface: "cron_inbox_reply_callback_sweep" } });
      return NextResponse.json({ error: "sweep failed" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, result: data });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_inbox_reply_callback_sweep" } });
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
