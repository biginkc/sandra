import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { runRoutingV2OutboxReplies, settleRoutingV2PhoneRepliesForCron } from "@/lib/ai-responder/dispatch";
import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

/**
 * Vercel cron -> `/api/cron/routing-v2-outbox` every minute (routing v2 cutover, step d).
 * 1. Outbox recovery: release claims that were never authorized, reconcile authorized
 *    replies from the outbound row keyed by the outbox id.
 * 2. Deliver due seller replies (each one: claim -> authorize -> provider fence -> send keyed
 *    by the outbox id -> mark sent). Owner alerts go through /api/cron/hold-alerts.
 * 3. PR-G settler: phone-action replies a crash left pending / sending (at most once).
 * With routing_v2 off there are no outbox or phone-action rows, so this reads and does nothing.
 * PR-C's claim reconcile and flag-off rollback already run at the start of every sequence tick.
 */
function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("routing v2 outbox needs Supabase service credentials.");
  return createSupabaseClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function handle(request: Request, deps: {
  client?: () => ReturnType<typeof createServiceRoleClient>;
  replies?: typeof runRoutingV2OutboxReplies;
  settle?: typeof settleRoutingV2PhoneRepliesForCron;
} = {}) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const supabase = (deps.client ?? createServiceRoleClient)();
    const replies = await (deps.replies ?? runRoutingV2OutboxReplies)(supabase, { limit: 20, budgetMs: 45_000 });
    let settled: unknown[] = [];
    try {
      settled = await (deps.settle ?? settleRoutingV2PhoneRepliesForCron)(supabase);
    } catch (error) {
      reportError(error, { tags: { surface: "cron_routing_v2_phone_settler" } });
    }
    return NextResponse.json({
      ok: true,
      released: replies.released,
      held: replies.held,
      reconciled: replies.reconciled,
      delivered: replies.results.map((r) => ({ id: r.id, kind: r.result.kind })),
      settled: settled.length,
    });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_routing_v2_outbox" } });
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}
export async function POST(request: Request) {
  return handle(request);
}
